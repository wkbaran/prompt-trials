import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadRegistry } from '../registry.ts';
import { privateFile, requireSuite } from './cases.ts';
import type { AppConfig } from './config.ts';
import { type ModelTotals, summarize } from './summarize.ts';

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface RunRecord {
  id: string;
  suite: string;
  models: string[];
  repeat: number;
  concurrency: number;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  evalId?: string;
  totals?: ModelTotals[];
  error?: string;
}

export interface RunRequest {
  suite: string;
  models: string[];
  repeat?: number;
  concurrency?: number;
}

const PROVIDER = 'file://../../src/provider.ts';

/** Environment for promptfoo children: local state in .promptfoo, no telemetry or sharing. */
export const promptfooEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PROMPTFOO_CONFIG_DIR: '.promptfoo',
  PROMPTFOO_DISABLE_TELEMETRY: '1',
  PROMPTFOO_DISABLE_UPDATE: '1',
  PROMPTFOO_DISABLE_SHARING: '1',
  NO_COLOR: '1',
});

/** The suite's config with its providers replaced by the chosen models. */
export function runConfig(suiteConfigYaml: string, models: string[], extraTests: string[] = []): string {
  const cfg = parse(suiteConfigYaml) as Record<string, unknown>;
  if (extraTests.length) cfg.tests = [...(Array.isArray(cfg.tests) ? cfg.tests : cfg.tests ? [cfg.tests] : []), ...extraTests];
  cfg.providers = models.map((m) => ({ id: PROVIDER, label: m, config: { model: m } }));
  return stringify(cfg, { lineWidth: 0 });
}

export class RunManager {
  private readonly children = new Map<string, ChildProcess>();
  private readonly listeners = new Map<string, Set<(line: string, done: boolean) => void>>();

  private readonly cfg: AppConfig;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    mkdirSync(cfg.runsDir, { recursive: true });
    // A run still marked running at startup was cut off by a restart.
    for (const r of this.list()) if (r.status === 'running') this.save({ ...r, status: 'failed', error: 'the app restarted during this run', endedAt: new Date().toISOString() });
  }

  private dir(id: string) {
    if (!/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id)) throw new Error('bad run id');
    return join(this.cfg.runsDir, id);
  }

  private save(r: RunRecord) {
    mkdirSync(this.dir(r.id), { recursive: true });
    writeFileSync(join(this.dir(r.id), 'run.json'), JSON.stringify(r, null, 2));
  }

  list(): RunRecord[] {
    if (!existsSync(this.cfg.runsDir)) return [];
    return readdirSync(this.cfg.runsDir)
      .filter((d) => existsSync(join(this.cfg.runsDir, d, 'run.json')))
      .map((d) => JSON.parse(readFileSync(join(this.cfg.runsDir, d, 'run.json'), 'utf8')) as RunRecord)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): RunRecord | undefined {
    const f = join(this.dir(id), 'run.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RunRecord) : undefined;
  }

  summary(id: string) {
    const f = join(this.dir(id), 'results.json');
    return existsSync(f) ? summarize(JSON.parse(readFileSync(f, 'utf8'))) : undefined;
  }

  log(id: string): string {
    const f = join(this.dir(id), 'log.txt');
    return existsSync(f) ? readFileSync(f, 'utf8') : '';
  }

  subscribe(id: string, fn: (line: string, done: boolean) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => set.delete(fn);
  }

  private emit(id: string, raw: string, done = false) {
    const text = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    if (text) appendFileSync(join(this.dir(id), 'log.txt'), text);
    for (const fn of this.listeners.get(id) ?? []) fn(text, done);
  }

  start(req: RunRequest): RunRecord {
    const suiteDir = requireSuite(this.cfg, req.suite);
    const known = ['@reference', ...Object.keys(loadRegistry().models)];
    if (!req.models?.length) throw new Error('choose at least one model');
    const bad = req.models.filter((m) => !known.includes(m));
    if (bad.length) throw new Error(`unknown model: ${bad.join(', ')}`);
    const repeat = Math.max(1, Math.min(50, Math.floor(req.repeat ?? 1)));
    const concurrency = Math.max(1, Math.min(16, Math.floor(req.concurrency ?? 1)));

    const now = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const id = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${randomBytes(2).toString('hex')}`;
    const run: RunRecord = { id, suite: req.suite, models: req.models, repeat, concurrency, status: 'running', startedAt: now.toISOString() };
    this.save(run);

    // The generated config sits beside the suite's own so its relative file:// paths still resolve.
    const cfgPath = join(suiteDir, `.run-${id}.yaml`);
    // Private cases kept outside the suite directory are added to the suite's own tests.
    const priv = privateFile(this.cfg, req.suite);
    const extra = this.cfg.privateCasesDir && existsSync(priv) ? [`file://${resolve(priv)}`] : [];
    writeFileSync(cfgPath, runConfig(readFileSync(join(suiteDir, 'promptfooconfig.yaml'), 'utf8'), req.models, extra));
    const results = join(this.dir(id), 'results.json');
    const args = ['eval', '-c', cfgPath, '--no-cache', '--no-progress-bar', '--repeat', String(repeat), '-j', String(concurrency), '-o', results];
    const child = spawn(join('node_modules', '.bin', 'promptfoo'), args, { env: promptfooEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set(id, child);
    this.emit(id, `$ promptfoo ${args.join(' ')}\n`);
    child.stdout.on('data', (d: Buffer) => this.emit(id, d.toString()));
    child.stderr.on('data', (d: Buffer) => this.emit(id, d.toString()));
    child.on('error', (e) => this.finish(id, cfgPath, undefined, e.message));
    child.on('close', (code) => this.finish(id, cfgPath, code ?? undefined));
    return run;
  }

  private finish(id: string, cfgPath: string, code?: number, spawnError?: string) {
    if (!this.children.has(id)) return;
    this.children.delete(id);
    const run = this.get(id)!;
    try {
      renameSync(cfgPath, join(this.dir(id), 'config.yaml'));
    } catch {
      rmSync(cfgPath, { force: true });
    }
    const summary = this.summary(id);
    // promptfoo exits 100 when some tests fail; that is a result, not a crash.
    const crashed = !summary || (code !== 0 && code !== 100);
    const status: RunStatus = run.status === 'cancelled' ? 'cancelled' : crashed ? 'failed' : 'done';
    this.save({
      ...run,
      status,
      endedAt: new Date().toISOString(),
      evalId: summary?.evalId,
      totals: summary?.models,
      ...(status === 'failed' ? { error: spawnError ?? `promptfoo exited with code ${code}` } : {}),
    });
    this.emit(id, `\n[${status}]\n`, true);
  }

  cancel(id: string): boolean {
    const child = this.children.get(id);
    const run = this.get(id);
    if (!child || !run) return false;
    this.save({ ...run, status: 'cancelled' });
    child.kill('SIGTERM');
    return true;
  }

  stopAll() {
    for (const c of this.children.values()) c.kill('SIGTERM');
  }
}
