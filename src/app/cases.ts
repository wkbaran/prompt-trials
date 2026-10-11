import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isMap, isSeq, parse, parseDocument, YAMLSeq } from 'yaml';
import * as A from '../assertions.ts';
import { outputFromReference } from '../fixture.ts';
import { type Assertion, parseAssertion } from './catalog.ts';
import type { AppConfig } from './config.ts';

export interface CaseInfo {
  suite: string;
  file: string;
  index: number;
  description: string;
  fixture: string;
  assertions: { raw: Assertion; id?: string; values?: Record<string, unknown> }[];
  /** Only cases in cases.private.yaml can be changed from the app. */
  editable: boolean;
}

export const PRIVATE_FILE = 'cases.private.yaml';
const HEADER = '# Cases built from your own recordings (gitignored; fixtures hold personal data).\n';

const safeName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s);

type Roots = Pick<AppConfig, 'suitesDir' | 'userSuitesDir'>;

const hasConfig = (dir: string, name: string) => existsSync(join(dir, name, 'promptfooconfig.yaml'));

/** Where a suite's folder is: the repo's suites, or the ones made in the app. */
export function locateSuite(cfg: Roots, suite: string): { dir: string; kind: 'shipped' | 'user' } | undefined {
  if (!safeName(suite)) return undefined;
  if (hasConfig(cfg.suitesDir, suite)) return { dir: join(cfg.suitesDir, suite), kind: 'shipped' };
  if (hasConfig(cfg.userSuitesDir, suite)) return { dir: join(cfg.userSuitesDir, suite), kind: 'user' };
  return undefined;
}

function namesIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && hasConfig(root, d.name))
    .map((d) => d.name);
}

export function suiteNames(cfg: Roots): string[] {
  return [...new Set([...namesIn(cfg.suitesDir), ...namesIn(cfg.userSuitesDir)])].sort();
}

export function requireSuite(cfg: Roots, suite: string): string {
  const found = locateSuite(cfg, suite);
  if (!found) throw new Error(`unknown suite "${suite}"`);
  return found.dir;
}

/** The file holding a suite's private cases. */
export function privateFile(cfg: Roots & Pick<AppConfig, 'privateCasesDir'>, suite: string): string {
  if (cfg.privateCasesDir) return join(cfg.privateCasesDir, `${suite}.yaml`);
  return join(locateSuite(cfg, suite)?.dir ?? join(cfg.suitesDir, suite), PRIVATE_FILE);
}

/** Every file of cases a suite runs: its own cases*.yaml, then the private file when that lives elsewhere. */
export function caseFiles(cfg: AppConfig, suite: string): { path: string; external: boolean }[] {
  const dir = requireSuite(cfg, suite);
  const files = readdirSync(dir).filter((f) => /^cases.*\.ya?ml$/.test(f)).sort().map((f) => ({ path: join(dir, f), external: false }));
  const priv = privateFile(cfg, suite);
  if (cfg.privateCasesDir && existsSync(priv)) files.push({ path: priv, external: true });
  return files;
}

export function listCases(cfg: AppConfig, suite: string): CaseInfo[] {
  const dir = requireSuite(cfg, suite);
  const out: CaseInfo[] = [];
  const priv = privateFile(cfg, suite);
  for (const { path } of caseFiles(cfg, suite)) {
    const file = cfg.privateCasesDir && path === priv ? `${suite}.yaml (private)` : path.slice(dir.length + 1);
    const list = parse(readFileSync(path, 'utf8')) as any[] | null;
    (list ?? []).forEach((c, index) => {
      out.push({
        suite,
        file,
        index,
        description: c.description ?? '(no description)',
        fixture: c.vars?.fixture ?? '',
        assertions: (c.assert ?? []).map((raw: Assertion) => ({ raw, ...parseAssertion(raw) })),
        editable: path === priv,
      });
    });
  }
  return out;
}

export interface CaseInput {
  description: string;
  fixture: string;
  assertions: Assertion[];
}

function loadPrivate(cfg: AppConfig, suite: string) {
  requireSuite(cfg, suite);
  const path = privateFile(cfg, suite);
  mkdirSync(dirname(path), { recursive: true });
  const doc = existsSync(path) ? parseDocument(readFileSync(path, 'utf8')) : parseDocument(`${HEADER}[]\n`);
  if (!isSeq(doc.contents)) doc.contents = new YAMLSeq() as any;
  const seq = doc.contents as YAMLSeq;
  seq.flow = false;
  return { path, doc, seq };
}

/** The private cases file is not in git, so keep the previous version beside it before every change. */
function writePrivate(path: string, doc: { toString(o: object): string }) {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, doc.toString({ lineWidth: 0 }));
}

function entry(c: CaseInput) {
  return { description: c.description, vars: { fixture: c.fixture }, assert: c.assertions };
}

export function saveCase(cfg: AppConfig, suite: string, c: CaseInput, index?: number): void {
  if (!c.description.trim()) throw new Error('give the case a description');
  if (!c.assertions.length) throw new Error('add at least one assertion');
  const { path, doc, seq } = loadPrivate(cfg, suite);
  const node = doc.createNode(entry(c));
  if (index === undefined) seq.add(node);
  else if (index >= 0 && index < seq.items.length) seq.items[index] = node;
  else throw new Error('that case no longer exists');
  writePrivate(path, doc);
}

/** Adds cases without the checks saveCase makes; used when a suite is copied. */
export function appendCases(cfg: AppConfig, suite: string, cases: CaseInput[]): void {
  const { path, doc, seq } = loadPrivate(cfg, suite);
  for (const c of cases) seq.add(doc.createNode(entry(c)));
  writePrivate(path, doc);
}

export function deleteCase(cfg: AppConfig, suite: string, index: number): void {
  const { path, doc, seq } = loadPrivate(cfg, suite);
  if (!(index >= 0 && index < seq.items.length)) throw new Error('that case no longer exists');
  seq.items.splice(index, 1);
  writePrivate(path, doc);
}

/** Writes a fixture under fixtures/<suite>/ and returns its path relative to the working directory. */
export function fixturePath(cfg: AppConfig, suite: string, name: string): string {
  requireSuite(cfg, suite);
  if (!safeName(name)) throw new Error('fixture names use letters, digits, dot, dash and underscore');
  const dir = join(cfg.fixturesDir, suite);
  mkdirSync(dir, { recursive: true });
  return relative(resolve('.'), resolve(dir, name.endsWith('.json') ? name : `${name}.json`));
}

export interface CheckResult {
  pass: boolean;
  reason: string;
}

/** Runs assertions against the fixture's recorded answer, in-process, so a case can be tried before it is saved. */
export function checkAssertions(fixtureFile: string, assertions: Assertion[]): CheckResult[] {
  const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
  const output = outputFromReference(fixture.reference);
  const text = JSON.stringify(output);
  return assertions.map((a) => {
    try {
      if (a.type === 'javascript') {
        const fn = String(a.value).split(':').pop() as string;
        const impl = (A as Record<string, unknown>)[fn];
        if (typeof impl !== 'function') return { pass: false, reason: `no assertion named ${fn}` };
        const r = impl(output, { config: a.config ?? {}, vars: { fixture: fixtureFile } }) as CheckResult;
        return { pass: r.pass, reason: r.reason };
      }
      if (a.type === 'icontains') return { pass: text.toLowerCase().includes(String(a.value).toLowerCase()), reason: `looked for "${a.value}"` };
      if (a.type === 'not-icontains') return { pass: !text.toLowerCase().includes(String(a.value).toLowerCase()), reason: `looked for "${a.value}"` };
      return { pass: false, reason: `the builder cannot try "${a.type}" assertions` };
    } catch (e) {
      return { pass: false, reason: (e as Error).message };
    }
  });
}
