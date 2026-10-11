import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, runNode, startNode, stop, until } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'pt-cli-'));
const servers: Server[] = [];
after(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

/** An OpenAI-style upstream: JSON answers, or an SSE stream when the request asks for one. */
async function upstream(): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body.stream) {
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_post', arguments: '{"ref":"T1"}' } }] } }], usage: { prompt_tokens: 7 } }),
        );
      }
      const chunk = (delta: object, extra: object = {}) => `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ reasoning: 'hmm. ' }));
      res.write(chunk({ content: 'Let me ' }));
      res.write(chunk({ content: 'look.' }));
      res.write(chunk({ tool_calls: [{ index: 0, id: 'c9', function: { name: 'read_', arguments: '{"re' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { name: 'post', arguments: 'f":"F2"}' } }] }, { finish_reason: 'tool_calls' }));
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const recordings = (out: string) => readdirSync(out).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')));

test('record-proxy forwards unchanged and records JSON and streamed answers', async () => {
  const up = await upstream();
  const port = await freePort();
  const out = join(dir, 'rec');
  const { child } = await startNode(['src/record-proxy.ts', '--upstream', up, '--port', String(port), '--host', '127.0.0.1', '--out', out], /recording 127\.0\.0\.1/);
  try {
    const post = (body: object) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const messages = [{ role: 'user', content: 'go' }];
    const tools = [{ type: 'function', function: { name: 'read_post' } }];

    const plain = await post({ model: 'm', messages, tools });
    assert.equal(plain.status, 200);
    assert.equal(((await plain.json()) as any).choices[0].message.tool_calls[0].function.name, 'read_post'); // passed through untouched

    const streamed = await post({ model: 'm', messages, tools, stream: true });
    assert.match(await streamed.text(), /\[DONE\]/); // the client still gets the whole stream

    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 200); // other paths are forwarded, not recorded
    await until('two recordings', () => recordings(out).length === 2);

    const [a, b] = recordings(out);
    assert.deepEqual(a.request.messages, messages);
    assert.deepEqual(a.request.tools, tools);
    assert.deepEqual(a.response.message.tool_calls[0].function, { name: 'read_post', arguments: '{"ref":"T1"}' });
    assert.equal(a.response.usage.prompt_tokens, 7);
    assert.equal(a.status, 200);
    // the stream is reassembled: split names and arguments rejoined, reasoning kept apart from content
    assert.equal(b.response.message.content, 'Let me look.');
    assert.equal(b.response.message.reasoning, 'hmm. ');
    assert.deepEqual(b.response.message.tool_calls[0].function, { name: 'read_post', arguments: '{"ref":"F2"}' });
    assert.equal(b.response.message.tool_calls[0].id, 'c9');
    assert.equal(b.response.finish_reason, 'tool_calls');
    assert.deepEqual(b.response.usage, { prompt_tokens: 11, completion_tokens: 3 });
  } finally {
    await stop(child);
  }
});

test('record-proxy answers 502 when the upstream is down, and needs --upstream', async () => {
  const dead = await freePort();
  const port = await freePort();
  const { child } = await startNode(['src/record-proxy.ts', '--upstream', `http://127.0.0.1:${dead}`, '--port', String(port), '--host', '127.0.0.1', '--out', join(dir, 'rec2')], /recording/);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 502);
  } finally {
    await stop(child);
  }
  const usage = await runNode(['src/record-proxy.ts']);
  assert.equal(usage.code, 2);
  assert.match(usage.out, /usage: record-proxy/);
});

test('cut lists conversations and writes a fixture with the recorded answer as its reference', async () => {
  const rec = join(dir, 'cutting');
  mkdirSync(rec);
  const file = (n: number, content: string, answer: object) =>
    writeFileSync(join(rec, `2026-10-11T12-00-0${n}-000000Z_000${n}.json`), JSON.stringify({ recordedAt: 'x', latencyMs: 12, request: { model: 'm', messages: [{ role: 'user', content }], tools: [{ type: 'function', function: { name: 't' } }] }, response: { message: answer, finish_reason: 'stop', usage: { prompt_tokens: 3 } } }));
  file(1, 'first conversation', { role: 'assistant', content: 'hello there' });
  file(2, 'second conversation', { role: 'assistant', content: null, tool_calls: [{ function: { name: 'read_post', arguments: '{}' } }] });

  const list = await runNode(['src/cut.ts', 'list', rec]);
  assert.equal(list.code, 0);
  assert.match(list.out, /# first conversation/);
  assert.match(list.out, /# second conversation/);
  assert.match(list.out, /text: hello there/);
  assert.match(list.out, /tool_calls: read_post/);

  const target = join(dir, 'fixtures', 'x.json');
  const pick = await runNode(['src/cut.ts', 'pick', join(rec, readdirSync(rec).sort()[1]!), target]);
  assert.equal(pick.code, 0);
  const fx = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(fx.messages, [{ role: 'user', content: 'second conversation' }]);
  assert.equal(fx.tools[0].function.name, 't');
  assert.equal(fx.reference.message.tool_calls[0].function.name, 'read_post');
  assert.equal(fx.reference.model, 'm');
  assert.match(fx.source, /_0002\.json$/); // remembers which recording it came from

  assert.equal((await runNode(['src/cut.ts'])).code, 2);
});

test('the loopback shim makes http servers listen on 127.0.0.1 only, unless a host is given', async () => {
  const probe = (listenArgs: string) =>
    runNode(['--import', new URL('../src/app/bind-loopback.mjs', import.meta.url).href, '-e', `const s = require('node:http').createServer(); s.listen(${listenArgs}, () => { console.log(s.address().address); s.close(); });`]);
  assert.equal((await probe('0')).out.trim(), '127.0.0.1');
  assert.equal((await probe("0, () => {}")).out.trim().split('\n')[0], '127.0.0.1'); // listen(port, callback) keeps the callback
  assert.equal((await probe("0, '0.0.0.0'")).out.trim(), '0.0.0.0'); // an explicit host is respected
});
