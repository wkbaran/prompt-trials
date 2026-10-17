/**
 * Import recorded requests from a LiteLLM proxy's spend logs into recordings/ (the same files
 * record-proxy.ts writes), so `cut.ts` can turn them into fixtures.
 *
 *   LITELLM_URL=http://host:4000 LITELLM_API_KEY=sk-... \
 *     node src/import-litellm.ts --since 2026-10-10T06:00:00Z [--until ...] [--model qwen3.8] \
 *       [--tag medium] [--min-prompt-tokens 0] --out recordings/medium
 *
 * Or read the proxy's S3 request logs instead (complete; the spend log drops requests when response ids repeat, as
 * Ollama's do): set S3_LOGS_BUCKET (and S3_LOGS_PREFIX, S3_LOGS_REGION, S3_LOGS_ENDPOINT) in place of the two above.
 * See src/s3-logs.ts.
 *
 * Needs on the proxy: `store_prompts_in_spend_logs` on, and MAX_STRING_LENGTH_PROMPT_IN_DB raised
 * (default 2048 truncates long messages). Rows are read from `proxy_server_request` (full request
 * incl. tools) and `response`; the `messages` column is empty in current versions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fetchFull, isAgentChat, listSpend, makeClient, recordingFileName, toRecording } from './litellm.ts';
import { makeS3Client, s3FromEnv } from './s3-logs.ts';

const { values } = parseArgs({
  options: {
    since: { type: 'string' },
    until: { type: 'string' },
    model: { type: 'string' },
    tag: { type: 'string' },
    'min-prompt-tokens': { type: 'string', default: '0' },
    out: { type: 'string', default: 'recordings/litellm' },
  },
});

const base = process.env.LITELLM_URL;
const key = process.env.LITELLM_API_KEY;
const s3 = s3FromEnv();
if (!(s3 || (base && key)) || !values.since) {
  console.error('usage: (LITELLM_URL=... LITELLM_API_KEY=... | S3_LOGS_BUCKET=...) import-litellm --since <ISO time> [--until <ISO>] [--model <substr>] [--tag <substr>] [--min-prompt-tokens N] [--out dir]');
  process.exit(2);
}

const client = s3 ? makeS3Client(s3) : makeClient(base!, key!);
const minPrompt = Number(values['min-prompt-tokens']);
const rows = await listSpend(client, new Date(values.since), values.until ? new Date(values.until) : new Date(Date.now() + 3600_000));

const wanted = rows
  .filter(isAgentChat)
  .filter((r) => !values.model || r.model.includes(values.model))
  .filter((r) => !values.tag || (r.request_tags ?? []).some((t) => t.includes(values.tag!)))
  .filter((r) => r.prompt_tokens >= minPrompt);

mkdirSync(values.out!, { recursive: true });
let written = 0;
let truncated = 0;
for (const [i, r] of wanted.entries()) {
  const full = await fetchFull(client, r.request_id);
  const rec = toRecording(full);
  if (!rec) {
    console.warn(`skip ${r.request_id}: no stored request (is store_prompts_in_spend_logs on?)`);
    continue;
  }
  const file = join(values.out!, recordingFileName(full.startTime, i + 1));
  writeFileSync(file, JSON.stringify(rec, null, 2));
  written++;
  if (JSON.stringify(rec.request).includes('truncated')) truncated++;
  console.log(`${file}  msgs=${rec.request.messages.length} tools=${rec.request.tools?.length ?? 0} prompt_tokens=${full.prompt_tokens}`);
}
console.log(`\n${written} of ${wanted.length} matching requests written to ${values.out}`);
if (truncated) console.warn(`warning: ${truncated} request(s) mention "truncated"; raise MAX_STRING_LENGTH_PROMPT_IN_DB on the proxy`);
