import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { fetchFull, isAgentChat, listSpend, toRecording } from '../src/litellm.ts';
import { makeS3Client, s3FromEnv, startOfKey } from '../src/s3-logs.ts';
import { importWindow, recentRuns } from '../src/app/litellm-runs.ts';
import type { AppConfig } from '../src/app/config.ts';
import { freePort, runNode } from './helpers.ts';

/** The object LiteLLM's s3_v2 logger writes for one request, cut down to what is read. */
function payload(o: { id: string; start: string; group?: string; user?: string; tools?: unknown[]; reply?: string }) {
  const start = Date.parse(o.start) / 1000;
  return {
    id: o.id,
    call_type: 'acompletion',
    model: `openai/${o.group ?? 'qwen'}`,
    model_group: o.group ?? 'qwen',
    status: 'success',
    prompt_tokens: 10,
    completion_tokens: 2,
    response_cost: 0.5,
    response_time: 1.5,
    startTime: start,
    endTime: start + 1.5,
    trace_id: 'trace-1',
    request_tags: [],
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: o.user ?? 'plain request' }],
    model_parameters: { temperature: 0, ...(o.tools ? { tools: o.tools } : {}) },
    response: { id: o.id, choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: o.reply ?? 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  };
}

/** `proxy/<date>/time-<HH-MM-SS-ffffff>_<id>.json`, as the logger names it. */
const keyFor = (start: string, id: string, prefix = 'proxy') => `${prefix}/${start.slice(0, 10)}/time-${start.slice(11, 19).replaceAll(':', '-')}-${start.slice(20, 26)}_${id}.json`;

/** A fake S3 that lists two keys per page, so paging is exercised, and counts the object reads. */
async function fakeS3(objects: Map<string, unknown>) {
  let gets = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = Number(url.searchParams.get('continuation-token') ?? 0);
      const more = from + 2 < all.length;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>logs</Name><Prefix>${prefix}</Prefix><KeyCount>${Math.min(2, all.length - from)}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ''}${all
          .slice(from, from + 2)
          .map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`)
          .join('')}</ListBucketResult>`,
      );
      return;
    }
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    gets++;
    if (!objects.has(key)) return void res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(objects.get(key)));
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${port}`;
  const s3 = new S3Client({ region: 'us-west-2', endpoint, forcePathStyle: true, credentials: { accessKeyId: 'k', secretAccessKey: 's' } });
  return { endpoint, s3, gets: () => gets, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const T = (min: number, sec = 0, micro = '000100') => `2026-10-11T12:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${micro}Z`;
const window = (a: string, b: string) => [new Date(a), new Date(b)] as const;

test('startOfKey reads the exact start time out of an object name', () => {
  assert.deepEqual(startOfKey(keyFor('2026-10-11T12:00:07.057123Z', 'chatcmpl-9')), { ms: Date.parse('2026-10-11T12:00:07.057Z'), list: '2026-10-11T12:00:07.057+00:00', full: '2026-10-11T12:00:07.057123Z' });
  assert.equal(startOfKey('proxy/2026-10-11/12/time-12-00-07-057123_x.json')?.full, '2026-10-11T12:00:07.057123Z'); // hourly folders
  assert.equal(startOfKey('proxy/2026-10-11/notes.json'), undefined);
});

test('s3FromEnv needs a bucket', () => {
  assert.equal(s3FromEnv({}), undefined);
  assert.deepEqual(s3FromEnv({ S3_LOGS_BUCKET: 'b', S3_LOGS_PREFIX: 'proxy', S3_LOGS_REGION: 'us-west-2' }), { bucket: 'b', prefix: 'proxy', region: 'us-west-2', endpoint: undefined });
});

test('lists a time window across pages and days, and keeps requests whose response ids repeat', async () => {
  const objects = new Map<string, unknown>();
  const add = (start: string, id: string) => objects.set(keyFor(start, id), payload({ id, start }));
  add('2026-10-10T23:59:30.000100Z', 'chatcmpl-1'); // the day before, inside the window
  add(T(0), 'chatcmpl-7');
  add(T(1), 'chatcmpl-7'); // same response id as the one before: the spend log would drop this one
  add(T(2), 'chatcmpl-8');
  add(T(30), 'chatcmpl-9'); // after the window
  add('2026-10-09T10:00:00.000100Z', 'chatcmpl-2'); // long before it
  objects.set('proxy/2026-10-11/readme.txt', 'x'); // not a log
  const fake = await fakeS3(objects);
  try {
    const client = makeS3Client({ bucket: 'logs', prefix: 'proxy', s3: fake.s3 });
    const rows = await listSpend(client, ...window('2026-10-10T23:50:00Z', '2026-10-11T12:10:00Z'));
    assert.deepEqual(rows.map((r) => r.startTime), ['2026-10-10T23:59:30.000+00:00', '2026-10-11T12:00:00.000+00:00', '2026-10-11T12:01:00.000+00:00', '2026-10-11T12:02:00.000+00:00']);
    assert.equal(new Set(rows.map((r) => r.request_id)).size, 4); // the object key is the id, so repeats stay apart
    assert.deepEqual(rows[1], { request_id: keyFor(T(0), 'chatcmpl-7'), model: 'openai/qwen', call_type: 'acompletion', prompt_tokens: 10, total_tokens: undefined, spend: 0.5, request_tags: [], startTime: '2026-10-11T12:00:00.000+00:00', endTime: '2026-10-11T12:00:01.500Z' });
    assert.ok(rows.every(isAgentChat));

    const reads = fake.gets();
    await listSpend(client, ...window('2026-10-10T23:50:00Z', '2026-10-11T12:10:00Z'));
    assert.equal(fake.gets(), reads); // objects never change, so they are read once
  } finally {
    await fake.close();
  }
});

test('a stored request becomes the recording the rest of the tools read', async () => {
  const tools = [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object' } } }];
  const key = keyFor(T(0, 7, '057123'), 'chatcmpl-5');
  const fake = await fakeS3(new Map([[key, payload({ id: 'chatcmpl-5', start: T(0, 7, '057123'), tools, reply: 'hello' })]]));
  try {
    const client = makeS3Client({ bucket: 'logs', prefix: '/proxy/', s3: fake.s3 }); // slashes around the prefix are fine
    const rec = toRecording(await fetchFull(client, key));
    assert.equal(rec?.recordedAt, '2026-10-11T12:00:07.057123Z');
    assert.equal(rec?.latencyMs, 1500);
    assert.equal(rec?.status, 200);
    assert.equal(rec?.request.model, 'qwen'); // the name asked for, not openai/qwen
    assert.deepEqual(rec?.request.tools, tools);
    assert.equal(rec?.request.messages.length, 2);
    assert.equal(rec?.response.message?.content, 'hello');
    assert.equal(rec?.litellm.request_id, key);
    await assert.rejects(client.get('/model/info', {}), /not available from S3/);
  } finally {
    await fake.close();
  }
});

test('the recent-runs panel and the importer work on S3 logs', async () => {
  const skill = 'x [IMPORTANT: The user has invoked the "spotify-discovery" skill, y';
  const objects = new Map<string, unknown>();
  for (const min of [0, 1, 2]) objects.set(keyFor(T(min), 'chatcmpl-1'), payload({ id: 'chatcmpl-1', start: T(min), user: skill })); // three requests, one repeated id
  objects.set(keyFor(T(40), 'chatcmpl-2'), payload({ id: 'chatcmpl-2', start: T(40), user: skill }));
  const fake = await fakeS3(objects);
  try {
    const root = mkdtempSync(join(tmpdir(), 'pt-s3-'));
    const cfg = { recordingsDir: join(root, 'recordings'), runsDir: join(root, 'runs') } as AppConfig;
    const client = makeS3Client({ bucket: 'logs', prefix: 'proxy', s3: fake.s3 });
    const now = new Date('2026-10-11T13:00:00Z');
    const runs = await recentRuns(cfg, client, 3, now);
    assert.deepEqual(runs.map((r) => [r.label, r.requests, r.imported]), [['spotify-discovery', 1, false], ['spotify-discovery', 3, false]]);
    assert.deepEqual(await importWindow(cfg, client, runs[1]!.start, runs[1]!.end, 'spotify'), { written: 3, skipped: 0 });
    assert.equal(readdirSync(join(cfg.recordingsDir, 'spotify')).length, 3);
    assert.equal((await recentRuns(cfg, client, 3, now))[1]!.imported, true);
  } finally {
    await fake.close();
  }
});

test('import-litellm reads S3 logs when S3_LOGS_BUCKET is set', async () => {
  const fake = await fakeS3(new Map([[keyFor(T(0), 'chatcmpl-3'), payload({ id: 'chatcmpl-3', start: T(0) })]]));
  try {
    const out = join(mkdtempSync(join(tmpdir(), 'pt-s3cli-')), 'rec');
    const r = await runNode(['src/import-litellm.ts', '--since', '2026-10-11T11:00:00Z', '--until', '2026-10-11T13:00:00Z', '--out', out], {
      S3_LOGS_BUCKET: 'logs', S3_LOGS_PREFIX: 'proxy', S3_LOGS_ENDPOINT: fake.endpoint, AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', LITELLM_URL: '', LITELLM_API_KEY: '',
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /1 of 1 matching requests written/);
    const [file] = readdirSync(out);
    assert.equal(JSON.parse(readFileSync(join(out, file!), 'utf8')).request.messages[1].content, 'plain request');
  } finally {
    await fake.close();
  }
});
