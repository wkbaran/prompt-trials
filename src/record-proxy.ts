/**
 * Recording pass-through proxy for OpenAI-compatible chat endpoints (Ollama /v1, LiteLLM, OpenRouter).
 *
 * Point a client (e.g. Hermes) at this proxy instead of the real endpoint for one run. Every
 * POST .../chat/completions is forwarded unchanged and saved with its response. Because an agent
 * resends the whole conversation on each call, every recorded request is a ready-made snapshot
 * at a decision point; `cut.ts` turns chosen ones into fixtures.
 *
 *   node src/record-proxy.ts --upstream http://localhost:11434 --port 11435 --out recordings/medium
 *
 * No local imports, so Node can run it directly.
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    upstream: { type: 'string' },
    port: { type: 'string', default: '11435' },
    out: { type: 'string', default: 'recordings' },
    host: { type: 'string', default: '0.0.0.0' },
  },
});

if (!values.upstream) {
  console.error('usage: record-proxy --upstream <base url, e.g. http://localhost:11434> [--port 11435] [--out recordings]');
  process.exit(2);
}
const upstream = values.upstream.replace(/\/$/, '');
const outDir = values.out!;
mkdirSync(outDir, { recursive: true });
let seq = 0;

/** Rebuild one assistant message from an SSE chat-completions stream. */
function assembleStream(text: string) {
  let content = '';
  let reasoning = '';
  let finish: string | undefined;
  let usage: unknown;
  const calls = new Map<number, { id?: string; name: string; arguments: string }>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    if (d.content) content += d.content;
    if (d.reasoning || d.reasoning_content) reasoning += d.reasoning ?? d.reasoning_content;
    for (const tc of d.tool_calls ?? []) {
      const cur = calls.get(tc.index ?? 0) ?? { name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index ?? 0, cur);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  return {
    message: {
      role: 'assistant',
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(calls.size
        ? {
            tool_calls: [...calls.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, c]) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
          }
        : {}),
    },
    finish_reason: finish,
    usage,
  };
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const started = performance.now();
  const url = upstream + (req.url ?? '');
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection'].includes(k)),
  ) as Record<string, string>;

  let up: Response;
  try {
    up = await fetch(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : body });
  } catch (e) {
    res.writeHead(502).end(`proxy: upstream failed: ${(e as Error).message}`);
    return;
  }

  const outHeaders: Record<string, string> = {};
  up.headers.forEach((v, k) => {
    if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) outHeaders[k] = v;
  });
  res.writeHead(up.status, outHeaders);

  const parts: Buffer[] = [];
  if (up.body) {
    for await (const part of up.body as unknown as AsyncIterable<Uint8Array>) {
      const b = Buffer.from(part);
      parts.push(b);
      res.write(b);
    }
  }
  res.end();

  if (!(req.url ?? '').includes('chat/completions') || req.method !== 'POST') return;
  try {
    const text = Buffer.concat(parts).toString('utf8');
    const request = JSON.parse(body.toString('utf8'));
    const streamed = text.startsWith('data:') || text.includes('\ndata:');
    const response = streamed
      ? assembleStream(text)
      : (() => {
          const j = JSON.parse(text);
          return { message: j.choices?.[0]?.message, finish_reason: j.choices?.[0]?.finish_reason, usage: j.usage };
        })();
    seq += 1;
    const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${String(seq).padStart(4, '0')}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        { recordedAt: new Date().toISOString(), status: up.status, latencyMs: Math.round(performance.now() - started), request, response },
        null,
        2,
      ),
    );
    console.log(`${file}  msgs=${request.messages?.length} tools=${request.tools?.length ?? 0} status=${up.status}`);
  } catch (e) {
    console.error(`could not record request: ${(e as Error).message}`);
  }
}).listen(Number(values.port), values.host, () => {
  console.log(`recording ${values.host}:${values.port} -> ${upstream}  (saving to ${outDir})`);
});
