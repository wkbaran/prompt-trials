/**
 * Import recorded requests from a LiteLLM proxy's spend logs into recordings/ (the same files
 * record-proxy.ts writes), so `cut.ts` can turn them into fixtures.
 *
 *   LITELLM_URL=http://host:4000 LITELLM_API_KEY=sk-... \
 *     node src/import-litellm.ts --since 2026-10-10T06:00:00Z [--until ...] [--model qwen3.8] \
 *       [--tag medium] [--min-prompt-tokens 0] --out recordings/medium
 *
 * Needs on the proxy: `store_prompts_in_spend_logs` on, and MAX_STRING_LENGTH_PROMPT_IN_DB raised
 * (default 2048 truncates long messages). Rows are read from `proxy_server_request` (full request
 * incl. tools) and `response`; the `messages` column is empty in current versions.
 * No local imports, so Node can run it directly.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

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

const base = process.env.LITELLM_URL?.replace(/\/$/, '');
const key = process.env.LITELLM_API_KEY;
if (!base || !key || !values.since) {
  console.error('usage: LITELLM_URL=... LITELLM_API_KEY=... import-litellm --since <ISO time> [--until <ISO>] [--model <substr>] [--tag <substr>] [--min-prompt-tokens N] [--out dir]');
  process.exit(2);
}

const headers = { authorization: `Bearer ${key}` };
const fmt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' '); // UTC "YYYY-MM-DD HH:MM:SS"
const start = fmt(new Date(values.since));
const end = fmt(values.until ? new Date(values.until) : new Date(Date.now() + 3600_000));
const minPrompt = Number(values['min-prompt-tokens']);

async function get(path: string, params: Record<string, string>) {
  const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { headers });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

interface ListRow {
  request_id: string;
  model: string;
  prompt_tokens: number;
  request_tags?: string[];
  startTime: string;
}

const rows: ListRow[] = [];
for (let page = 1; ; page++) {
  const d = await get('/spend/logs/ui', { start_date: start, end_date: end, page_size: '100', page: String(page) });
  rows.push(...d.data);
  if (page >= (d.total_pages ?? 1)) break;
}

const wanted = rows
  .filter((r) => !values.model || r.model.includes(values.model))
  .filter((r) => !values.tag || (r.request_tags ?? []).some((t) => t.includes(values.tag!)))
  .filter((r) => r.prompt_tokens >= minPrompt)
  .sort((a, b) => a.startTime.localeCompare(b.startTime));

mkdirSync(values.out!, { recursive: true });
let written = 0;
let truncated = 0;
for (const [i, r] of wanted.entries()) {
  const full = (await get('/spend/logs', { request_id: r.request_id }))[0];
  const req = full?.proxy_server_request;
  if (!req?.messages) {
    console.warn(`skip ${r.request_id}: no stored request (is store_prompts_in_spend_logs on?)`);
    continue;
  }
  const choice = full.response?.choices?.[0];
  const file = join(values.out!, `${full.startTime.replace(/[:.]/g, '-')}_${String(i + 1).padStart(4, '0')}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        recordedAt: full.startTime,
        status: full.status === 'failure' ? 500 : 200,
        latencyMs: full.request_duration_ms,
        request: { model: req.model, messages: req.messages, tools: req.tools, tool_choice: req.tool_choice },
        response: { message: choice?.message, finish_reason: choice?.finish_reason, usage: full.response?.usage },
        litellm: { request_id: full.request_id, session_id: full.session_id, spend: full.spend, model_group: full.model_group },
      },
      null,
      2,
    ),
  );
  written++;
  if (JSON.stringify(req).includes('truncated')) truncated++;
  console.log(`${file}  msgs=${req.messages.length} tools=${req.tools?.length ?? 0} prompt_tokens=${full.prompt_tokens}`);
}
console.log(`\n${written} of ${wanted.length} matching requests written to ${values.out}`);
if (truncated) console.warn(`warning: ${truncated} request(s) mention "truncated"; raise MAX_STRING_LENGTH_PROMPT_IN_DB on the proxy`);
