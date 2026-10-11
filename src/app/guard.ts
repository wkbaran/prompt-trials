import type { AppConfig, BusyWindow } from './config.ts';
import type { ModelEntry } from '../registry.ts';

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Warnings for busy windows that are active now or start within `lookahead` minutes. */
export function windowWarnings(windows: BusyWindow[], now: Date, lookahead: number): string[] {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out: string[] = [];
  for (const w of windows) {
    if (w.days && !w.days.includes(now.getDay())) continue;
    const from = minutes(w.from);
    const to = minutes(w.to);
    if (nowMin >= from && nowMin < to) out.push(`"${w.label}" is running now (${w.from}-${w.to}) and may be using the GPU.`);
    else if (from > nowMin && from - nowMin <= lookahead) out.push(`"${w.label}" starts at ${w.from}, in ${from - nowMin} minutes.`);
  }
  return out;
}

export function isLocalModel(entry: ModelEntry, ollamaUrl?: string): boolean {
  if (entry.gpu !== undefined) return entry.gpu;
  try {
    const host = new URL(entry.apiBaseUrl).hostname;
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return true;
    return Boolean(ollamaUrl) && new URL(ollamaUrl!).hostname === host;
  } catch {
    return false;
  }
}

const bare = (name: string) => name.replace(/:latest$/, '');

/** Checks that apply when a run includes models served from the local GPU. Empty when it is safe to start. */
export async function guardWarnings(
  models: Record<string, ModelEntry>,
  chosen: string[],
  cfg: Pick<AppConfig, 'ollamaUrl' | 'busyWindows' | 'lookaheadMinutes'>,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const local = chosen.filter((id) => models[id] && isLocalModel(models[id], cfg.ollamaUrl));
  if (!local.length) return [];
  const warnings = windowWarnings(cfg.busyWindows, now, cfg.lookaheadMinutes);
  const wanted = [...new Set(local.map((id) => models[id]!.model))];
  if (wanted.length > 1) warnings.push(`This run uses ${wanted.length} local models (${wanted.join(', ')}). Only one large model fits in VRAM, so Ollama will keep swapping them.`);
  if (cfg.ollamaUrl) {
    try {
      const res = await fetchImpl(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(3000) });
      const loaded = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => bare(m.name)) ?? [];
      const others = loaded.filter((n) => !wanted.map(bare).includes(n));
      if (others.length) warnings.push(`Ollama has ${others.join(', ')} loaded. Running ${wanted.join(', ')} will unload it, and whatever is using it will reload it afterwards.`);
    } catch {
      warnings.push(`Cannot reach Ollama at ${cfg.ollamaUrl}, so local models will probably fail.`);
    }
  }
  return warnings;
}
