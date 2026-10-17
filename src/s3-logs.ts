/**
 * Reading recorded agent requests from the S3 objects a LiteLLM proxy writes with its `s3_v2` logger, as a
 * stand-in for the spend-log API in litellm.ts. Everything built on that module (the importer, the app's
 * "recent runs" panel) works unchanged on top of it.
 *
 * Why: the spend log's primary key is the provider's response id, and Ollama's ids are `chatcmpl-0` to
 * `chatcmpl-998`, so a busy proxy silently drops a growing share of requests. The S3 objects are named
 * `<prefix>/<date>/time-<HH-MM-SS-ffffff>_<response id>.json`, with the start time to the microsecond in the
 * name, so they do not collide. Each holds the full request, the response and the cost.
 *
 * Needs on the proxy: `success_callback: ["s3_v2"]` with `s3_callback_params` listed before it in config.yaml.
 * Needs here: read access to the bucket. Credentials come from the usual AWS chain (env, profile, SSO).
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { Client, ListRow } from './litellm.ts';

export interface S3Source {
  bucket: string;
  /** Folder the proxy writes under (`s3_path`). */
  prefix?: string;
  region?: string;
  /** For S3-compatible servers such as MinIO. */
  endpoint?: string;
  /** Bring your own client (the tests do). */
  s3?: S3Client;
}

export function s3FromEnv(env: NodeJS.ProcessEnv = process.env): S3Source | undefined {
  if (!env.S3_LOGS_BUCKET) return undefined;
  return { bucket: env.S3_LOGS_BUCKET, prefix: env.S3_LOGS_PREFIX, region: env.S3_LOGS_REGION, endpoint: env.S3_LOGS_ENDPOINT };
}

/** The start time in an object's name; it is UTC, and the only exact copy of the microseconds. */
const KEY_TIME = /(\d{4}-\d{2}-\d{2})\/(?:\d{2}\/)?time-(\d{2})-(\d{2})-(\d{2})-(\d{6})_/;

export function startOfKey(key: string): { ms: number; list: string; full: string } | undefined {
  const m = KEY_TIME.exec(key);
  if (!m) return undefined;
  const [, date, hh, mm, ss, micro] = m;
  const base = `${date}T${hh}:${mm}:${ss}`;
  return { ms: Date.parse(`${base}.${micro!.slice(0, 3)}Z`), list: `${base}.${micro!.slice(0, 3)}+00:00`, full: `${base}.${micro}Z` };
}

const epochIso = (s: unknown) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : undefined);
/** LiteLLM wants and sends UTC "YYYY-MM-DD HH:MM:SS". */
const parseWindow = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');

function listRow(key: string, p: any): ListRow {
  return {
    request_id: key,
    model: p.model ?? '',
    call_type: p.call_type,
    prompt_tokens: p.prompt_tokens ?? 0,
    total_tokens: p.total_tokens,
    spend: p.response_cost,
    request_tags: p.request_tags,
    startTime: startOfKey(key)!.list,
    endTime: epochIso(p.endTime),
  };
}

/** The shape the spend API's single-request endpoint returns, which toRecording() reads. */
function fullRow(key: string, p: any) {
  const params = p.model_parameters ?? {};
  return {
    request_id: key,
    startTime: startOfKey(key)!.full,
    endTime: epochIso(p.endTime),
    request_duration_ms: typeof p.response_time === 'number' ? Math.round(p.response_time * 1000) : undefined,
    status: p.status,
    session_id: p.session_id || p.trace_id,
    spend: p.response_cost,
    model_group: p.model_group,
    prompt_tokens: p.prompt_tokens,
    // The name the agent asked for, not the provider route behind it (`openai/qwen...`).
    proxy_server_request: { model: p.model_group ?? p.model, messages: p.messages, tools: params.tools, tool_choice: params.tool_choice },
    response: p.response,
  };
}

export function makeS3Client(src: S3Source): Client {
  const s3 =
    src.s3 ?? new S3Client({ ...(src.region ? { region: src.region } : {}), ...(src.endpoint ? { endpoint: src.endpoint, forcePathStyle: true } : {}) });
  const prefix = (src.prefix ?? '').replace(/^\/+|\/+$/g, '');
  const rows = new Map<string, ListRow>();

  async function read(key: string): Promise<any> {
    const res = await s3.send(new GetObjectCommand({ Bucket: src.bucket, Key: key }));
    return JSON.parse(await res.Body!.transformToString());
  }

  async function keysOn(date: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: src.bucket, Prefix: `${prefix ? prefix + '/' : ''}${date}/`, ContinuationToken: token }));
      out.push(...(page.Contents ?? []).flatMap((o) => (o.Key?.endsWith('.json') ? [o.Key] : [])));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** Objects never change, so what was learned about one is kept. Reading is the slow part: 8 at a time. */
  async function listing(from: number, to: number): Promise<ListRow[]> {
    const keys: string[] = [];
    for (let day = Date.UTC(...ymd(from)); day <= to; day += 86_400_000) {
      for (const key of await keysOn(new Date(day).toISOString().slice(0, 10))) {
        const t = startOfKey(key)?.ms;
        if (t !== undefined && t >= from && t <= to) keys.push(key);
      }
    }
    const fresh = keys.filter((k) => !rows.has(k));
    for (let i = 0; i < fresh.length; i += 8) {
      await Promise.all(fresh.slice(i, i + 8).map(async (k) => rows.set(k, listRow(k, await read(k)))));
    }
    return keys.map((k) => rows.get(k)!);
  }

  return {
    async get(path, params) {
      if (path === '/spend/logs/ui') {
        return { data: await listing(parseWindow(params.start_date!), parseWindow(params.end_date!)), total_pages: 1 };
      }
      if (path === '/spend/logs') return [fullRow(params.request_id!, await read(params.request_id!))];
      throw new Error(`${path} is not available from S3 logs`);
    },
  };
}

const ymd = (ms: number): [number, number, number] => {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
};
