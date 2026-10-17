/**
 * The control app: launch runs, browse results, turn recordings into cases.
 *   npm run app        then open http://127.0.0.1:5180
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRegistry } from '../registry.ts';
import { basicAuthOk, CHALLENGE, credentialsFromEnv } from './auth.ts';
import { buildAssertion, CATALOG, type Values } from './catalog.ts';
import { checkAssertions, deleteCase, listCases, requireSuite, saveCase } from './cases.ts';
import { loadAppConfig } from './config.ts';
import { guardWarnings, isLocalModel } from './guard.ts';
import { viewerProxy } from './proxy.ts';
import { conversations, cutFixture, deleteRecordingDir, listRecordingDirs, stepDetail } from './recordings.ts';
import { promptfooEnv, RunManager } from './runs.ts';
import { importWindow, recentRuns, setHidden } from './litellm-runs.ts';
import { makeClient } from '../litellm.ts';
import { makeS3Client } from '../s3-logs.ts';
import { createSuite, deleteSuite, getSuite, listSuites, updateSuite } from './suites.ts';

const cfg = loadAppConfig();
const creds = credentialsFromEnv();
const runs = new RunManager(cfg);
/** Where the Recordings page reads runs from: the proxy's S3 logs when set up (they are complete), else its spend log. */
const litellm = cfg.s3Logs ? makeS3Client(cfg.s3Logs) : process.env.LITELLM_URL && process.env.LITELLM_API_KEY ? makeClient(process.env.LITELLM_URL, process.env.LITELLM_API_KEY) : undefined;
const logSource = cfg.s3Logs ? 's3' : 'litellm';
/** promptfoo's viewer runs on this loopback-only port; the public viewer port is the app's own proxy in front of it. */
const viewerInternalPort = cfg.viewerPort + 1;
const PUBLIC = join(import.meta.dirname, 'public');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2_000_000) throw new HttpError(413, 'request too large');
    chunks.push(c as Buffer);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'the request body is not valid JSON');
  }
}

function registryOrEmpty() {
  try {
    return { models: loadRegistry().models, error: undefined as string | undefined };
  } catch (e) {
    return { models: {}, error: (e as Error).message };
  }
}

// ---- viewer (promptfoo's own result browser), kept running beside the app
let viewer: ChildProcess | undefined;
let viewerUp = false;
function startViewer() {
  if (process.env.VIEWER === 'off') return; // for tests and for hosts that do not want it
  const loopback = pathToFileURL(join(import.meta.dirname, 'bind-loopback.mjs')).href;
  const env = { ...promptfooEnv(), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${loopback}`.trim() };
  viewer = spawn(join('node_modules', '.bin', 'promptfoo'), ['view', '-p', String(viewerInternalPort), '-n'], { env, stdio: 'ignore' });
  viewer.on('exit', () => {
    viewerUp = false;
    viewer = undefined;
  });
}
async function probeViewer() {
  try {
    viewerUp = (await fetch(`http://127.0.0.1:${viewerInternalPort}/`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    viewerUp = false;
  }
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
  const [a, b, c] = parts;
  const method = req.method ?? 'GET';

  if (a === 'config' && method === 'GET') return send(res, 200, { busyWindows: cfg.busyWindows, viewerPort: cfg.viewerPort, ollama: Boolean(cfg.ollamaUrl), auth: Boolean(creds) });

  if (a === 'models' && method === 'GET') {
    const { models, error } = registryOrEmpty();
    const list = [
      { id: '@reference', label: 'Recorded answer', detail: 'replays the stored answer, no model', gpu: false },
      ...Object.entries(models).map(([id, m]) => ({
        id,
        label: id,
        detail: `${m.model} · $${m.price.input}/$${m.price.output} per Mtok`,
        gpu: isLocalModel(m, cfg.ollamaUrl),
      })),
    ];
    return send(res, 200, { models: list, error });
  }

  if (a === 'guard' && method === 'GET') {
    const chosen = (url.searchParams.get('models') ?? '').split(',').filter(Boolean);
    return send(res, 200, { warnings: await guardWarnings(registryOrEmpty().models, chosen, cfg) });
  }

  if (a === 'catalog' && method === 'GET') return send(res, 200, { assertions: CATALOG });

  if (a === 'suites') {
    const defaults = (body: { defaultAssertions?: { id: string; values: Values }[] }) => (body.defaultAssertions ?? []).map((x) => buildAssertion(x.id, x.values ?? {}));
    if (method === 'GET' && !b) return send(res, 200, { suites: listSuites(cfg) });
    if (method === 'GET' && b) return send(res, 200, getSuite(cfg, b));
    if (method === 'POST' && !b) {
      const body = await readJson(req);
      createSuite(cfg, body.name, { description: body.description ?? '', defaultAssertions: defaults(body) }, body.copyFrom);
      return send(res, 200, { ok: true, name: body.name });
    }
    if (method === 'PUT' && b) {
      const body = await readJson(req);
      updateSuite(cfg, b, { description: body.description ?? '', defaultAssertions: defaults(body) });
      return send(res, 200, { ok: true });
    }
    if (method === 'DELETE' && b) {
      deleteSuite(cfg, b);
      return send(res, 200, { ok: true });
    }
  }

  if (a === 'cases') {
    if (method === 'GET' && b) return send(res, 200, { cases: listCases(cfg, b) });
    if (method === 'POST' && !b) {
      const body = await readJson(req);
      const assertions = (body.assertions as { id: string; values: Values }[]).map((x) => buildAssertion(x.id, x.values ?? {}));
      requireSuite(cfg, body.suite);
      let fixture: string = body.fixture;
      if (body.recording) fixture = cutFixture(cfg, body.recording.dir, body.recording.file, body.suite, body.fixtureName);
      if (body.check) return send(res, 200, { fixture, results: checkAssertions(fixture, assertions) });
      saveCase(cfg, body.suite, { description: body.description, fixture, assertions }, body.index);
      return send(res, 200, { ok: true, fixture });
    }
    if (method === 'DELETE' && b && c) {
      deleteCase(cfg, b, Number(c));
      return send(res, 200, { ok: true });
    }
  }

  if (a === 'recordings') {
    if (method === 'GET' && !b) return send(res, 200, { dirs: listRecordingDirs(cfg) });
    if (method === 'GET' && b && !c) return send(res, 200, { conversations: conversations(cfg, b) });
    if (method === 'GET' && b && c) return send(res, 200, stepDetail(cfg, b, c));
    if (method === 'DELETE' && b && !c) return send(res, 200, { deleted: deleteRecordingDir(cfg, b) });
  }

  if (a === 'runs') {
    if (method === 'GET' && !b) return send(res, 200, { runs: runs.list() });
    if (method === 'POST' && !b) {
      const body = await readJson(req);
      const warnings = await guardWarnings(registryOrEmpty().models, body.models ?? [], cfg);
      if (warnings.length && !body.force) throw new HttpError(409, JSON.stringify(warnings));
      return send(res, 200, runs.start(body));
    }
    if (method === 'GET' && b && !c) {
      const run = runs.get(b);
      if (!run) throw new HttpError(404, 'no such run');
      return send(res, 200, { run, summary: runs.summary(b), log: run.status === 'running' ? undefined : runs.log(b) });
    }
    if (method === 'POST' && b && c === 'cancel') return send(res, 200, { cancelled: runs.cancel(b) });
    if (method === 'GET' && b && c === 'log') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const write = (line: string, done: boolean) => {
        if (line) res.write(`data: ${JSON.stringify(line)}\n\n`);
        if (done) {
          res.write('event: done\ndata: {}\n\n');
          res.end();
        }
      };
      write(runs.log(b), runs.get(b)?.status !== 'running');
      if (runs.get(b)?.status === 'running') {
        const off = runs.subscribe(b, write);
        req.on('close', off);
      }
      return;
    }
  }

  if (a === 'litellm') {
    if (!litellm) return send(res, 200, { configured: false, runs: [] });
    if (method === 'GET' && b === 'recent') {
      const days = Math.max(1, Math.min(14, Number(url.searchParams.get('days') ?? 3) || 3));
      return send(res, 200, { configured: true, source: logSource, runs: await recentRuns(cfg, litellm, days) });
    }
    if (method === 'POST' && b === 'hide') {
      const body = await readJson(req);
      setHidden(cfg, String(body.start), Boolean(body.hidden));
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && b === 'import') {
      const body = await readJson(req);
      return send(res, 200, await importWindow(cfg, litellm, String(body.start), String(body.end), String(body.folder)));
    }
  }

  if (a === 'viewer' && method === 'GET') {
    await probeViewer();
    return send(res, 200, { up: viewerUp, port: cfg.viewerPort });
  }

  throw new HttpError(404, 'not found');
}

function serveStatic(res: ServerResponse, pathname: string) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = readFileSync(join(PUBLIC, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  if (creds && !basicAuthOk(req.headers.authorization, creds)) {
    // A short pause makes password guessing slow without needing any state.
    await new Promise((r) => setTimeout(r, 400));
    return void res.writeHead(401, CHALLENGE).end('login required');
  }
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(res, url.pathname);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    if (!res.headersSent) send(res, status, { error: (e as Error).message });
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`prompt-trials app: http://${cfg.host}:${cfg.port}  (results viewer on :${cfg.viewerPort}, login ${creds ? 'required' : 'off'})`);
  if (!creds && !['127.0.0.1', '::1', 'localhost'].includes(cfg.host)) {
    console.warn(`WARNING: listening on ${cfg.host} without a login. Set TRIALS_AUTH_USER and TRIALS_AUTH_PASSWORD.`);
  }
});
const proxy = viewerProxy(cfg.host, cfg.viewerPort, viewerInternalPort, creds);
startViewer();
const stop = () => {
  runs.stopAll();
  viewer?.kill('SIGTERM');
  proxy.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
