import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { freePort, startNode, stop, until } from './helpers.ts';

/**
 * Boots the real server (viewer off) against throwaway folders and drives it over HTTP: login, suites,
 * a case built from a recording, a real promptfoo run on the recorded answer, and cleanup.
 */
const root = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'pt-server-'));
// User suites must sit beside src/ (the generated config reaches ../../src), so this folder lives in the project, untracked.
const userSuites = mkdtempSync(join(root, 'user-suites-test-'));
const auth = `Basic ${Buffer.from('tester:s3cret').toString('base64')}`;
let child: ChildProcess;
let base = '';

before(async () => {
  for (const d of ['recordings/rec1', 'fixtures', 'runs', 'cases', 'pf']) mkdirSync(join(tmp, d), { recursive: true });
  writeFileSync(
    join(tmp, 'recordings/rec1/a.json'),
    JSON.stringify({
      recordedAt: '2026-10-11T12:00:00Z',
      latencyMs: 5,
      request: { model: 'm', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'read_post' } }] },
      response: { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_post', arguments: '{"ref":"T1"}' } }] }, finish_reason: 'tool_calls' },
    }),
  );
  writeFileSync(join(tmp, 'models.yaml'), 'models:\n  dummy:\n    apiBaseUrl: http://127.0.0.1:9/v1\n    model: x\n    price: { input: 0, output: 0 }\n');
  writeFileSync(join(tmp, 'trials.config.yaml'), `recordingsDir: ${join(tmp, 'recordings')}\nfixturesDir: ${join(tmp, 'fixtures')}\nrunsDir: ${join(tmp, 'runs')}\n`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  ({ child } = await startNode(['src/app/server.ts'], /prompt-trials app:/, {
    HOST: '127.0.0.1',
    PORT: String(port),
    VIEWER_PORT: String(await freePort()),
    VIEWER: 'off',
    TRIALS_AUTH_USER: 'tester',
    TRIALS_AUTH_PASSWORD: 's3cret',
    PROMPT_TRIALS_CONFIG: join(tmp, 'trials.config.yaml'),
    PROMPT_TRIALS_MODELS: join(tmp, 'models.yaml'),
    USER_SUITES_DIR: userSuites,
    PRIVATE_CASES_DIR: join(tmp, 'cases'),
    SHIPPED_SUITES: 'hide',
    PROMPTFOO_CONFIG_DIR: join(tmp, 'pf'),
    LITELLM_URL: '',
    LITELLM_API_KEY: '',
  }));
});

after(async () => {
  await stop(child);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(userSuites, { recursive: true, force: true });
});

async function api(path: string, body?: unknown, method?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('login: only /healthz is open, and the wrong password is refused', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/api/suites`)).status, 401);
  assert.equal((await fetch(`${base}/api/suites`, { headers: { authorization: `Basic ${Buffer.from('tester:wrong').toString('base64')}` } })).status, 401);
  const page = await fetch(`${base}/`, { headers: { authorization: auth } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Prompt Trials<\/title>/);
});

test('static files cannot reach outside the app folder', async () => {
  const status = await new Promise<number>((resolve) => {
    const req = request(`${base}`, { path: '/../../package.json', headers: { authorization: auth } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.end();
  });
  assert.equal(status, 404);
});

test('catalog, models and the GPU guard answer', async () => {
  assert.ok((await api('catalog')).json.assertions.some((a: any) => a.id === 'callsTool'));
  const { models } = (await api('models')).json;
  assert.deepEqual(models.map((m: any) => m.id), ['@reference', 'dummy']);
  assert.deepEqual((await api('guard?models=@reference')).json.warnings, []);
  assert.equal((await api('litellm/recent')).json.configured, false); // no proxy configured in this run
  assert.equal((await api('nope')).status, 404);
});

test('suites: shipped ones hidden, create, reject duplicates and bad names', async () => {
  assert.deepEqual((await api('suites')).json.suites, []);
  assert.equal((await api('suites', { name: 'itest', description: 'Integration test suite', defaultAssertions: [] })).status, 200);
  assert.equal((await api('suites', { name: 'itest', description: 'again', defaultAssertions: [] })).status, 400);
  assert.equal((await api('suites', { name: 'Bad Name', description: 'x', defaultAssertions: [] })).status, 400);
  assert.deepEqual((await api('suites')).json.suites.map((s: any) => [s.name, s.kind, s.cases]), [['itest', 'user', 0]]);
});

test('a suite with no cases will not run', async () => {
  const res = await api('runs', { suite: 'itest', models: ['@reference'] });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /no cases yet/);
});

test('recordings are browsable and become a case: try the checks, save, edit, list', async () => {
  assert.deepEqual((await api('recordings')).json.dirs, [{ name: 'rec1', files: 1 }]);
  const step = (await api('recordings/rec1/a.json')).json;
  assert.ok(step.tools.includes('read_post'));
  assert.equal(step.answer.toolCalls[0].name, 'read_post');

  const checks = [{ id: 'callsTool', values: { names: ['read_post'] } }, { id: 'avoidsTool', values: { names: ['digest_finish'] } }, { id: 'startsWith', values: { pattern: 'Medium' } }];
  const tried = await api('cases', { suite: 'itest', description: 'reads the post first', recording: { dir: 'rec1', file: 'a.json' }, fixtureName: 'step-one', assertions: checks, check: true });
  assert.deepEqual(tried.json.results.map((r: any) => r.pass), [true, true, false]); // the last check fails on the recorded answer, as it should
  assert.deepEqual((await api('cases', { suite: 'itest', description: 'x', recording: { dir: 'rec1', file: 'a.json' }, fixtureName: 'bad name!', assertions: checks, check: true })).status, 400);

  assert.equal((await api('cases', { suite: 'itest', description: 'reads the post first', recording: { dir: 'rec1', file: 'a.json' }, fixtureName: 'step-one', assertions: checks.slice(0, 2) })).status, 200);
  const { cases } = (await api('cases/itest')).json;
  assert.deepEqual(cases.map((c: any) => [c.description, c.editable, c.assertions.map((a: any) => a.id)]), [['reads the post first', true, ['callsTool', 'avoidsTool']]]);
  assert.equal(readdirSync(join(tmp, 'fixtures', 'itest')).length, 1); // the fixture file was cut from the recording
  assert.equal((await api('cases', { suite: 'itest', description: 'renamed', fixture: cases[0].fixture, assertions: checks.slice(0, 1), index: 0 })).status, 200);
  assert.equal((await api('cases/itest')).json.cases[0].description, 'renamed');
});

test('a real run on the recorded answer finishes with every attempt passing', async () => {
  const started = await api('runs', { suite: 'itest', models: ['@reference'], repeat: 2 });
  assert.equal(started.status, 200);
  const id = started.json.id;
  const done = await until('the run to finish', async () => {
    const r = (await api(`runs/${id}`)).json;
    return r.run.status !== 'running' ? r : undefined;
  }, 90_000, 500);
  assert.equal(done.run.status, 'done', done.run.error);
  assert.deepEqual(done.summary.models.map((m: any) => [m.label, m.passed, m.total]), [['@reference', 2, 2]]);
  assert.equal(done.summary.tests.length, 1); // two repeats, one test row
  assert.match(done.log, /passed/);
  assert.ok((await api('runs')).json.runs.some((r: any) => r.id === id));
  const bad = await api('runs', { suite: 'itest', models: ['nonexistent'] });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unknown model/);
  assert.equal((await api('runs/20000101-000000-abcd')).status, 404);
  assert.equal((await api('runs/not-an-id')).status, 400);
});

test('deleting: a case, a recordings folder and a suite (moved aside, not erased)', async () => {
  assert.equal((await api('cases/itest/0', undefined, 'DELETE')).status, 200);
  assert.deepEqual((await api('cases/itest')).json.cases, []);
  assert.equal((await api('recordings/rec1', undefined, 'DELETE')).json.deleted, 1);
  assert.deepEqual((await api('recordings')).json.dirs, []);
  assert.equal((await api('suites/itest', undefined, 'DELETE')).status, 200);
  assert.deepEqual((await api('suites')).json.suites, []);
  assert.equal(readdirSync(join(userSuites, '.trash')).length, 1);
  assert.match(readFileSync(join(tmp, 'runs', readdirSync(join(tmp, 'runs'))[0]!, 'run.json'), 'utf8'), /"status": "done"/); // history is kept
});
