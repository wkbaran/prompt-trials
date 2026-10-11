import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000, everyMs = 100): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Starts `node <args>` and resolves once its output contains `ready`. */
export async function startNode(args: string[], ready: RegExp, env: Record<string, string> = {}): Promise<{ child: ChildProcess; output: () => string }> {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d));
  child.stderr!.on('data', (d: Buffer) => (out += d));
  await until(`${args.join(' ')} to print ${ready}`, () => ready.test(out) || child.exitCode !== null);
  if (child.exitCode !== null) throw new Error(`exited early (${child.exitCode}): ${out}`);
  return { child, output: () => out };
}

export function runNode(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d));
    child.stderr!.on('data', (d: Buffer) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

export const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('close', () => resolve());
    child.kill('SIGTERM');
  });
