import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// With a `litellm` section in models.yaml every model goes through the proxy and its per-call cost is used.
const dir = mkdtempSync(join(tmpdir(), 'pt-provider-ll-'));
let server: Server;
let costHeader: string | undefined;
const seen: { url?: string; auth?: string; model?: string }[] = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, model: JSON.parse(Buffer.concat(chunks).toString('utf8')).model });
      res.writeHead(200, { 'content-type': 'application/json', ...(costHeader ? { 'x-litellm-response-cost': costHeader } : {}) }).end(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 0 } }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(
    join(dir, 'models.yaml'),
    `litellm:\n  baseUrl: ${base}/v1\n  apiKeyEnv: PT_LL_KEY\nmodels:\n  m:\n    apiBaseUrl: http://unreachable.invalid/v1\n    model: litellm-alias\n    price: { input: 10, output: 0 }\n`,
  );
  process.env.PROMPT_TRIALS_MODELS = join(dir, 'models.yaml');
  process.env.PT_LL_KEY = 'sk-proxy';
});

after(() => new Promise<void>((r) => server.close(() => r())));

const run = async () => {
  const { default: Provider } = await import('../src/provider.ts');
  const f = join(dir, 'fx.json');
  writeFileSync(f, JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }));
  return (await new Provider({ config: { model: 'm' } }).callApi('', { vars: { fixture: f } })) as any;
};

test('calls go to the proxy with its key, and the proxy reports the cost', async () => {
  costHeader = '0.0421';
  const out = await run();
  assert.deepEqual(seen[0], { url: '/v1/chat/completions', auth: 'Bearer sk-proxy', model: 'litellm-alias' });
  assert.equal(out.cost, 0.0421); // the header, not the registry's $10/Mtok
});

test('without the cost header the registry price is the fallback', async () => {
  costHeader = undefined;
  const out = await run();
  assert.ok(Math.abs(out.cost - 0.01) < 1e-12, String(out.cost)); // 1000 tokens at $10 per million
});
