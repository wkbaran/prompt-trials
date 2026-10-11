import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Client, type Cluster, clusterRows, TIMESTAMP_KEY_LENGTH, describeRun, fetchFull, isAgentChat, listSpend, recordingFileName, timestampKey, toRecording } from '../litellm.ts';
import type { AppConfig } from './config.ts';

export interface RecentRun {
  /** Start of the first request, as sent back to import it. */
  start: string;
  end: string;
  requests: number;
  models: string[];
  /** The skill the run invoked, or the opening words of its first message. */
  label: string;
  promptTokens: number;
  spend: number;
  imported: boolean;
  importedAs?: string;
  /** Hidden by you; stays hidden until you show it again. */
  hidden: boolean;
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Runs you hid are remembered beside the run history (a data volume in the container), keyed by when the run started. */
const hiddenFile = (cfg: Pick<AppConfig, 'runsDir'>) => join(dirname(cfg.runsDir), 'hidden-litellm-runs.json');

export function readHidden(cfg: Pick<AppConfig, 'runsDir'>): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(hiddenFile(cfg), 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

export function setHidden(cfg: Pick<AppConfig, 'runsDir'>, start: string, hidden: boolean): void {
  const keys = readHidden(cfg);
  const key = timestampKey(start);
  if (hidden) keys.add(key);
  else keys.delete(key);
  mkdirSync(dirname(hiddenFile(cfg)), { recursive: true });
  writeFileSync(hiddenFile(cfg), JSON.stringify([...keys].sort(), null, 2));
}

/** Recording file-name prefixes already on disk, mapped to the folder holding them. */
export function importedPrefixes(cfg: Pick<AppConfig, 'recordingsDir'>): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(cfg.recordingsDir)) return out;
  for (const d of readdirSync(cfg.recordingsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(cfg.recordingsDir, d.name))) if (f.endsWith('.json')) out.set(f.slice(0, TIMESTAMP_KEY_LENGTH), d.name); // the timestamp part, without the microseconds, the Z or the _NNNN suffix
  }
  return out;
}

const labels = new Map<string, string>();

async function labelFor(client: Client, c: Cluster): Promise<string> {
  const first = c.rows[0]!;
  const cached = labels.get(first.request_id);
  if (cached) return cached;
  try {
    const label = describeRun((await fetchFull(client, first.request_id))?.proxy_server_request?.messages);
    labels.set(first.request_id, label);
    return label;
  } catch {
    return '(could not read)';
  }
}

/** Runs seen by the proxy in the last `days` days, newest first. */
export async function recentRuns(cfg: AppConfig, client: Client, days: number, now = new Date()): Promise<RecentRun[]> {
  const rows = (await listSpend(client, new Date(now.getTime() - days * 86_400_000), new Date(now.getTime() + 3_600_000))).filter(isAgentChat);
  const clusters = clusterRows(rows);
  const have = importedPrefixes(cfg);
  const hidden = readHidden(cfg);
  const described: RecentRun[] = [];
  // Labelling reads one stored request per run; eight at a time is quick and still easy on the proxy.
  for (let i = 0; i < clusters.length; i += 8) {
    described.push(
      ...(await Promise.all(
        clusters.slice(i, i + 8).map(async (c): Promise<RecentRun> => {
          const folders = c.rows.map((r) => have.get(timestampKey(r.startTime)));
          const imported = folders.every(Boolean);
          return {
            start: c.start,
            end: c.end,
            requests: c.rows.length,
            models: [...new Set(c.rows.map((r) => r.model))],
            label: await labelFor(client, c),
            promptTokens: c.rows.reduce((a, r) => a + (r.prompt_tokens ?? 0), 0),
            spend: c.rows.reduce((a, r) => a + (r.spend ?? 0), 0),
            imported,
            hidden: hidden.has(timestampKey(c.start)),
            ...(imported ? { importedAs: folders[0] } : {}),
          };
        }),
      )),
    );
  }
  return described.reverse();
}

/** Writes every agent request between `start` and `end` into recordings/<folder>. */
export async function importWindow(cfg: AppConfig, client: Client, start: string, end: string, folder: string): Promise<{ written: number; skipped: number }> {
  if (!SAFE.test(folder)) throw new Error('folder names use letters, digits, dot, dash and underscore');
  const from = new Date(Date.parse(start) - 1000);
  const to = new Date(Date.parse(end) + 1000);
  if (!(from < to) || to.getTime() - from.getTime() > 12 * 3_600_000) throw new Error('that time range is not a single run');
  const rows = (await listSpend(client, from, to)).filter(isAgentChat);
  const dir = join(cfg.recordingsDir, folder);
  mkdirSync(dir, { recursive: true });
  let written = 0;
  let skipped = 0;
  for (const [i, r] of rows.entries()) {
    const full = await fetchFull(client, r.request_id);
    const rec = toRecording(full);
    if (!rec) {
      skipped++;
      continue;
    }
    writeFileSync(join(dir, recordingFileName(full.startTime, i + 1)), JSON.stringify(rec, null, 2));
    written++;
  }
  return { written, skipped };
}
