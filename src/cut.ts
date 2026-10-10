/**
 * Turn recordings (from record-proxy) into fixtures.
 *
 *   node src/cut.ts list recordings/medium
 *       One line per recorded request, grouped into conversations by their first user message.
 *       Shows the message count and what the recorded model answered (tool names or text).
 *
 *   node src/cut.ts pick recordings/medium/<file>.json fixtures/medium-digest/after-first-batch.json
 *       Writes { messages, tools, tool_choice?, reference } for the provider to replay.
 *       `reference` is the answer the recorded model gave; assertions may compare against it.
 *
 * No local imports, so Node can run it directly.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

interface Recording {
  recordedAt: string;
  latencyMs: number;
  request: { model?: string; messages: { role: string; content?: unknown }[]; tools?: unknown[]; tool_choice?: unknown };
  response: {
    message?: { content?: string | null; tool_calls?: { function: { name: string; arguments: string } }[] };
    finish_reason?: string;
    usage?: unknown;
  };
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('');
  return '';
}

const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'list' && a) {
  const files = readdirSync(a).filter((f) => f.endsWith('.json')).sort();
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const rec = JSON.parse(readFileSync(join(a, f), 'utf8')) as Recording;
    const firstUser = rec.request.messages.find((m) => m.role === 'user');
    const key = text(firstUser?.content).slice(0, 80).replace(/\s+/g, ' ') || '(no user message)';
    const m = rec.response.message;
    const answer = m?.tool_calls?.length
      ? 'tool_calls: ' + m.tool_calls.map((c) => c.function.name).join(', ')
      : 'text: ' + text(m?.content).slice(0, 60).replace(/\s+/g, ' ');
    const line = `  ${f}  msgs=${String(rec.request.messages.length).padStart(3)}  ${String(rec.latencyMs).padStart(6)}ms  ${answer}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  for (const [key, lines] of groups) {
    console.log(`\n# ${key}`);
    lines.forEach((l) => console.log(l));
  }
} else if (cmd === 'pick' && a && b) {
  const rec = JSON.parse(readFileSync(a, 'utf8')) as Recording;
  mkdirSync(dirname(b), { recursive: true });
  writeFileSync(
    b,
    JSON.stringify(
      {
        messages: rec.request.messages,
        ...(rec.request.tools ? { tools: rec.request.tools } : {}),
        ...(rec.request.tool_choice ? { tool_choice: rec.request.tool_choice } : {}),
        reference: { model: rec.request.model, ...rec.response },
        source: basename(a),
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${b} (${rec.request.messages.length} messages)`);
} else {
  console.error('usage:\n  cut.ts list <recordings dir>\n  cut.ts pick <recording.json> <fixture.json>');
  process.exit(2);
}
