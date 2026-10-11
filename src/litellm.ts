/**
 * Reading recorded agent requests out of a LiteLLM proxy's spend logs. Shared by the import-litellm
 * command and the app's "Recent runs" panel.
 *
 * Needs on the proxy: `store_prompts_in_spend_logs` on, and MAX_STRING_LENGTH_PROMPT_IN_DB raised
 * (the default of 2048 truncates long messages). The full request (messages and tools) is in
 * `proxy_server_request` and the answer in `response`; the `messages` column is empty.
 */

export interface ListRow {
  request_id: string;
  model: string;
  call_type?: string;
  prompt_tokens: number;
  total_tokens?: number;
  spend?: number;
  request_tags?: string[];
  startTime: string;
  endTime?: string;
}

export interface Client {
  get(path: string, params: Record<string, string>): Promise<any>;
}

export function makeClient(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Client {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async get(path, params) {
      const res = await fetchImpl(`${base}${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res.json();
    },
  };
}

/** LiteLLM wants UTC "YYYY-MM-DD HH:MM:SS". */
const fmt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

export async function listSpend(client: Client, since: Date, until: Date): Promise<ListRow[]> {
  const rows: ListRow[] = [];
  for (let page = 1; ; page++) {
    const d = await client.get('/spend/logs/ui', { start_date: fmt(since), end_date: fmt(until), page_size: '100', page: String(page) });
    rows.push(...d.data);
    if (page >= (d.total_pages ?? 1)) break;
  }
  return rows.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** Chat requests from an agent: not embeddings, and not the Jev classifier. */
export function isAgentChat(r: ListRow): boolean {
  return (r.call_type ?? 'acompletion').includes('completion') && r.model !== 'jev';
}

export async function fetchFull(client: Client, requestId: string): Promise<any> {
  return (await client.get('/spend/logs', { request_id: requestId }))[0];
}

/** The file recordings are stored as (the same shape record-proxy writes), or undefined when the proxy kept no request body. */
export function toRecording(full: any) {
  const req = full?.proxy_server_request;
  if (!req?.messages) return undefined;
  const choice = full.response?.choices?.[0];
  return {
    recordedAt: full.startTime,
    status: full.status === 'failure' ? 500 : 200,
    latencyMs: full.request_duration_ms,
    request: { model: req.model, messages: req.messages, tools: req.tools, tool_choice: req.tool_choice },
    response: { message: choice?.message, finish_reason: choice?.finish_reason, usage: full.response?.usage },
    litellm: { request_id: full.request_id, session_id: full.session_id, spend: full.spend, model_group: full.model_group },
  };
}

/**
 * The part of a recording's file name that identifies a request: its start time to the millisecond.
 * The list endpoint gives milliseconds (`...07.057+00:00`) and the stored request microseconds
 * (`...07.057000Z`), so both are compared at millisecond precision.
 */
export const TIMESTAMP_KEY_LENGTH = 23;
export const timestampKey = (startTime: string): string => startTime.slice(0, TIMESTAMP_KEY_LENGTH).replace(/[:.]/g, '-');
export const recordingFileName = (startTime: string, n: number): string => `${startTime.replace(/[:.]/g, '-')}_${String(n).padStart(4, '0')}.json`;

export interface Cluster {
  start: string;
  end: string;
  rows: ListRow[];
}

/** Requests belong together while no more than `gapMs` passes between one starting and the next. */
export function clusterRows(rows: ListRow[], gapMs = 5 * 60_000): Cluster[] {
  const out: Cluster[] = [];
  for (const r of rows) {
    const last = out.at(-1);
    const t = Date.parse(r.startTime);
    if (last && t - Date.parse(last.end) <= gapMs) {
      last.rows.push(r);
      last.end = r.endTime && Date.parse(r.endTime) > t ? r.endTime : r.startTime;
    } else {
      out.push({ start: r.startTime, end: r.endTime ?? r.startTime, rows: [r] });
    }
  }
  return out;
}

/** What a run was, from the first user message of its first request: the skill it invoked, or the opening words. */
export function describeRun(messages: { role: string; content?: unknown }[] | undefined): string {
  const first = messages?.find((m) => m.role === 'user');
  const text = typeof first?.content === 'string' ? first.content : Array.isArray(first?.content) ? first.content.map((p: any) => p?.text ?? '').join('') : '';
  const skill = /invoked the "([^"]+)" skill/.exec(text)?.[1];
  if (skill) return skill;
  return text.replace(/\s+/g, ' ').trim().slice(0, 70) || '(no user message)';
}
