/**
 * Turn recordings (from record-proxy or import-litellm) into fixtures.
 *
 *   node src/cut.ts list recordings/medium
 *       One line per recorded request, grouped into conversations by their first user message.
 *       Shows the message count and what the recorded model answered (tool names or text).
 *
 *   node src/cut.ts pick recordings/medium/<file>.json fixtures/medium-digest/after-first-batch.json
 *       Writes { messages, tools, tool_choice?, reference } for the provider to replay.
 *       `reference` is the answer the recorded model gave; assertions may compare against it.
 *
 * The app (npm run app) does the same from a browser.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { answerSummary, groupConversations, readRecording, toFixture } from './fixture.ts';

const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'list' && a) {
  for (const [key, steps] of groupConversations(a)) {
    console.log(`\n# ${key}`);
    for (const { file, rec } of steps) {
      console.log(`  ${file}  msgs=${String(rec.request.messages.length).padStart(3)}  ${String(rec.latencyMs).padStart(6)}ms  ${answerSummary(rec)}`);
    }
  }
} else if (cmd === 'pick' && a && b) {
  const rec = readRecording(a);
  mkdirSync(dirname(b), { recursive: true });
  writeFileSync(b, JSON.stringify(toFixture(rec, basename(a)), null, 2));
  console.log(`wrote ${b} (${rec.request.messages.length} messages)`);
} else {
  console.error('usage:\n  cut.ts list <recordings dir>\n  cut.ts pick <recording.json> <fixture.json>');
  process.exit(2);
}
