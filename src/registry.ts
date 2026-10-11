import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelEntry {
  apiBaseUrl: string;
  /** Name of the env var holding the API key; omit for keyless endpoints (Ollama). */
  apiKeyEnv?: string;
  model: string;
  /** True when the model runs on this machine's GPU (Ollama): the app warns before runs that would clash with other GPU users. Guessed from a localhost URL when omitted. */
  gpu?: boolean;
  price: Price;
  /** Extra chat-completions body fields (temperature, max_tokens, reasoning_effort, ...). */
  params?: Record<string, unknown>;
}

export interface Registry {
  litellm?: { baseUrl?: string; apiKeyEnv?: string };
  models: Record<string, ModelEntry>;
}

function interpolate(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`models.yaml uses \${${name}} but it is not set in the environment`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  }
  return value;
}

let cached: Registry | undefined;

export function loadRegistry(path = process.env.PROMPT_TRIALS_MODELS ?? 'models.yaml'): Registry {
  if (cached) return cached;
  const file = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Cannot read ${file}. Copy models.example.yaml to models.yaml and edit it.`);
  }
  const reg = interpolate(parse(raw)) as Registry;
  if (!reg.models) throw new Error(`${file} has no "models" section`);
  cached = reg;
  return reg;
}

export function getModel(id: string): ModelEntry {
  const reg = loadRegistry();
  const entry = reg.models[id];
  if (!entry) throw new Error(`Unknown model "${id}". Known: ${Object.keys(reg.models).join(', ')}`);
  return entry;
}
