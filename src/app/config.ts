import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { type S3Source, s3FromEnv } from '../s3-logs.ts';

/** Times when the GPU or the model server is shared with something else (for example a scheduled agent). */
export interface BusyWindow {
  label: string;
  /** 0 = Sunday ... 6 = Saturday. Every day when omitted. */
  days?: number[];
  /** Local time, "HH:MM". */
  from: string;
  to: string;
}

export interface AppConfig {
  host: string;
  port: number;
  viewerPort: number;
  /** Where the app finds things, relative to the working directory. */
  suitesDir: string;
  /** Suites you create in the app live here, one folder each, beside (not inside) the suites that ship with the repo. */
  userSuitesDir: string;
  /** False hides the suites that ship with the repo (and their example cases), leaving only the suites made in the app. */
  showShippedSuites: boolean;
  recordingsDir: string;
  fixturesDir: string;
  runsDir: string;
  /** Where each suite's private cases live (`<dir>/<suite>.yaml`). Unset: `cases.private.yaml` beside the suite's config. */
  privateCasesDir?: string;
  /** Where the proxy's S3 request logs are (complete, unlike its spend log). Preferred over LITELLM_URL for the Recordings page. */
  s3Logs?: Omit<S3Source, 's3'>;
  /** Base URL of the Ollama server, for the "what is loaded" check. */
  ollamaUrl?: string;
  busyWindows: BusyWindow[];
  /** Warn when a busy window starts within this many minutes. */
  lookaheadMinutes: number;
}

export function loadAppConfig(path = process.env.PROMPT_TRIALS_CONFIG ?? 'trials.config.yaml'): AppConfig {
  const file = resolve(path);
  const user = existsSync(file) ? ((parse(readFileSync(file, 'utf8')) ?? {}) as Partial<AppConfig>) : {};
  return {
    host: process.env.HOST ?? user.host ?? '127.0.0.1',
    port: Number(process.env.PORT ?? user.port ?? 5180),
    viewerPort: Number(process.env.VIEWER_PORT ?? user.viewerPort ?? 15500),
    suitesDir: user.suitesDir ?? 'suites',
    userSuitesDir: process.env.USER_SUITES_DIR ?? user.userSuitesDir ?? 'user-suites',
    showShippedSuites: process.env.SHIPPED_SUITES ? process.env.SHIPPED_SUITES !== 'hide' : (user.showShippedSuites ?? true),
    recordingsDir: user.recordingsDir ?? 'recordings',
    fixturesDir: user.fixturesDir ?? 'fixtures',
    runsDir: user.runsDir ?? 'output/runs',
    privateCasesDir: process.env.PRIVATE_CASES_DIR ?? user.privateCasesDir,
    s3Logs: s3FromEnv() ?? user.s3Logs,
    ollamaUrl: process.env.OLLAMA_URL ?? user.ollamaUrl,
    busyWindows: user.busyWindows ?? [],
    lookaheadMinutes: user.lookaheadMinutes ?? 30,
  };
}
