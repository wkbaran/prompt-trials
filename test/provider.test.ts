import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCost } from '../src/cost.ts';
import { getModel, parseRegistry } from '../src/registry.ts';

// The registry reads PROMPT_TRIALS_MODELS once per process, so this file sets it up before the provider runs.
const dir = mkdtempSync(join(tmpdir(), 'pt-provider-'));
let server: Server;
let base = '';
const seen: { url?: string; auth?: string; body?: any }[] = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (body.model === 'boom-model') return void res.writeHead(500).end('upstream exploded');
      const bad = body.model === 'bad-args-model';
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [{ finish_reason: 'tool_calls', message: { content: 'thinking out loud', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_post', arguments: bad ? '{bad' : '{"ref":"T1"}' } }] } }],
          usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 }, cache_creation_input_tokens: 100 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(
    join(dir, 'models.yaml'),
    `models:
  paid:
    apiBaseUrl: ${base}/v1
    apiKeyEnv: PT_TEST_KEY
    model: vendor/paid-model
    price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    params: { temperature: 0.2, max_tokens: 100 }
  keyless:
    apiBaseUrl: ${base}/v1
    model: keyless-model
    price: { input: 0, output: 0 }
  bad:
    apiBaseUrl: ${base}/v1
    model: bad-args-model
    price: { input: 0, output: 0 }
  boom:
    apiBaseUrl: ${base}/v1
    model: boom-model
    price: { input: 0, output: 0 }
  needskey:
    apiBaseUrl: ${base}/v1
    apiKeyEnv: PT_MISSING_KEY
    model: x
    price: { input: 0, output: 0 }
`,
  );
  process.env.PROMPT_TRIALS_MODELS = join(dir, 'models.yaml');
  process.env.PT_TEST_KEY = 'sk-test-123';
  delete process.env.PT_MISSING_KEY;
});

after(() => new Promise<void>((r) => server.close(() => r())));

const fixture = (extra: Record<string, unknown> = {}) => {
  const p = join(dir, `fx-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'go' }],
      tools: [{ type: 'function', function: { name: 'read_post', parameters: { type: 'object' } } }],
      reference: { message: { content: '', tool_calls: [{ function: { name: 'digest_finish', arguments: '{"gists":{}}' } }] }, finish_reason: 'tool_calls' },
      ...extra,
    }),
  );
  return p;
};

async function provider(model: string, params?: Record<string, unknown>) {
  const { default: Provider } = await import('../src/provider.ts');
  return new Provider({ config: { model, ...(params ? { params } : {}) } });
}

test('@reference replays the stored answer with no model, no cost and no latency', async () => {
  const out: any = await (await provider('@reference')).callApi('', { vars: { fixture: fixture() } });
  assert.deepEqual(out.output.tool_calls, [{ name: 'digest_finish', arguments: { gists: {} } }]);
  assert.equal(out.cost, 0);
  assert.equal(out.latencyMs, 0);
  assert.equal(seen.length, 0); // nothing was sent anywhere
});

test('fixture problems are reported, not thrown', async () => {
  const p = await provider('@reference');
  assert.match(String(((await p.callApi('', {})) as any).error), /needs a `fixture` var/);
  assert.match(String(((await p.callApi('', { vars: { fixture: join(dir, 'nope.json') } })) as any).error), /cannot read fixture/);
  const noRef = fixture({ reference: undefined });
  assert.match(String(((await p.callApi('', { vars: { fixture: noRef } })) as any).error), /no reference answer/);
});

test('a real model gets the fixture as a chat request and its answer is parsed, with tokens and cost', async () => {
  seen.length = 0;
  const out: any = await (await provider('paid', { temperature: 0.9 })).callApi('', { vars: { fixture: fixture() } });
  const req = seen[0]!;
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.auth, 'Bearer sk-test-123');
  assert.equal(req.body.model, 'vendor/paid-model'); // the registry's model name, not the key
  assert.equal(req.body.stream, false);
  assert.equal(req.body.messages.length, 2);
  assert.equal(req.body.tools[0].function.name, 'read_post');
  assert.equal(req.body.temperature, 0.9); // the suite's params win over models.yaml
  assert.equal(req.body.max_tokens, 100); // and models.yaml params still apply
  assert.deepEqual(out.output.tool_calls, [{ name: 'read_post', arguments: { ref: 'T1' } }]);
  assert.equal(out.output.content, 'thinking out loud');
  assert.equal(out.output.finish_reason, 'tool_calls');
  assert.deepEqual([out.tokenUsage.prompt, out.tokenUsage.completion, out.tokenUsage.cached, out.tokenUsage.total], [1000, 50, 400, 1050]);
  // 500 fresh at $3, 400 cached at $0.30, 100 cache writes at $3.75, 50 out at $15, per million tokens
  assert.ok(Math.abs(out.cost - 0.002745) < 1e-9, String(out.cost));
  assert.equal(out.cost, computeCost(getModel('paid').price, { promptTokens: 1000, completionTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 100 }));
  assert.ok(out.latencyMs >= 0);
});

test('keyless endpoints send no Authorization header', async () => {
  seen.length = 0;
  await (await provider('keyless')).callApi('', { vars: { fixture: fixture() } });
  assert.equal(seen[0]!.auth, undefined);
});

test('tool arguments that are not JSON come back marked, so validToolArguments can fail them', async () => {
  const out: any = await (await provider('bad')).callApi('', { vars: { fixture: fixture() } });
  assert.deepEqual(out.output.tool_calls[0].arguments, { __unparsed: '{bad' });
});

test('HTTP errors and a missing API key are reported as errors', async () => {
  const boom: any = await (await provider('boom')).callApi('', { vars: { fixture: fixture() } });
  assert.match(boom.error, /HTTP 500: upstream exploded/);
  const key: any = await (await provider('needskey')).callApi('', { vars: { fixture: fixture() } });
  assert.match(key.error, /PT_MISSING_KEY is not set/);
});

test('unknown models and a missing model setting fail loudly', async () => {
  const { default: Provider } = await import('../src/provider.ts');
  assert.throws(() => new Provider({ config: {} }), /needs `model/);
  await assert.rejects(async () => (await provider('nope')).callApi('', { vars: { fixture: fixture() } }), /Unknown model "nope"/);
});

test('parseRegistry: environment substitution and shape checks', () => {
  process.env.PT_REG_HOST = 'http://example.test';
  const reg = parseRegistry('models:\n  m:\n    apiBaseUrl: ${PT_REG_HOST}/v1\n    model: x\n    price: { input: 1, output: 2 }\n');
  assert.equal(reg.models.m!.apiBaseUrl, 'http://example.test/v1');
  assert.throws(() => parseRegistry('models:\n  m:\n    apiBaseUrl: ${PT_NOT_SET_ANYWHERE}\n    model: x\n    price: { input: 1, output: 2 }\n'), /PT_NOT_SET_ANYWHERE.*not set/);
  assert.throws(() => parseRegistry('litellm: {}\n', 'my.yaml'), /my\.yaml has no "models" section/);
});
