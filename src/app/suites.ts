import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { type Assertion, ASSERTIONS_FILE, parseAssertion } from './catalog.ts';
import { appendCases, listCases, locateSuite, privateFile, suiteNames } from './cases.ts';
import type { AppConfig } from './config.ts';

/**
 * Suites you make in the app live in cfg.userSuitesDir, outside git, so a redeploy keeps them and the
 * repo never drifts from what the app shows. The suites that ship with the repo stay read-only here;
 * "copy" turns one into your own.
 */

export interface SuiteInfo {
  name: string;
  kind: 'shipped' | 'user';
  description: string;
  cases: number;
}

export interface SuiteDetail extends SuiteInfo {
  /** Checks applied to every case, besides the always-on valid-arguments check. */
  defaultAssertions: { raw: Assertion; id?: string; values?: Record<string, unknown> }[];
}

export interface SuiteInput {
  description: string;
  defaultAssertions: Assertion[];
}

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const VALID_ARGS = `${ASSERTIONS_FILE}:validToolArguments`;
const isAlwaysOn = (a: Assertion) => a.type === 'javascript' && a.value === VALID_ARGS;

function readConfig(dir: string): { description?: string; defaultTest?: { assert?: Assertion[] } } {
  return (parse(readFileSync(join(dir, 'promptfooconfig.yaml'), 'utf8')) ?? {}) as ReturnType<typeof readConfig>;
}

export function suiteConfigYaml(input: SuiteInput): string {
  return (
    '# Made in the app. Change it there: the file is regenerated whenever the suite is saved.\n' +
    stringify(
      {
        description: input.description,
        prompts: ['{{fixture}}'],
        // The run launcher replaces these with the models chosen for each run.
        providers: [{ id: 'file://../../src/provider.ts', label: 'reference-answer', config: { model: '@reference' } }],
        defaultTest: { assert: [{ type: 'javascript', value: VALID_ARGS }, ...input.defaultAssertions.filter((a) => !isAlwaysOn(a))] },
        tests: 'file://cases*.yaml',
      },
      { lineWidth: 0 },
    )
  );
}

export function listSuites(cfg: AppConfig): SuiteInfo[] {
  return suiteNames(cfg).map((name) => {
    const found = locateSuite(cfg, name)!;
    return { name, kind: found.kind, description: readConfig(found.dir).description ?? '', cases: listCases(cfg, name).length };
  });
}

export function getSuite(cfg: AppConfig, name: string): SuiteDetail {
  const found = locateSuite(cfg, name);
  if (!found) throw new Error(`unknown suite "${name}"`);
  const conf = readConfig(found.dir);
  return {
    name,
    kind: found.kind,
    description: conf.description ?? '',
    cases: listCases(cfg, name).length,
    defaultAssertions: (conf.defaultTest?.assert ?? []).filter((a) => !isAlwaysOn(a)).map((raw) => ({ raw, ...parseAssertion(raw) })),
  };
}

function requireUserSuite(cfg: AppConfig, name: string) {
  const found = locateSuite(cfg, name);
  if (!found) throw new Error(`unknown suite "${name}"`);
  if (found.kind !== 'user') throw new Error('suites that ship with the repo are read-only here; copy it to change it');
  return found.dir;
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

export function createSuite(cfg: AppConfig, name: string, input: SuiteInput, copyFrom?: string): void {
  if (!NAME.test(name)) throw new Error('names use lowercase letters, digits and dashes, 2 to 40 characters, starting with a letter or digit');
  if (locateSuite(cfg, name)) throw new Error(`a suite called "${name}" already exists`);
  if (!input.description.trim()) throw new Error('give the suite a description');
  const dir = join(cfg.userSuitesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'promptfooconfig.yaml'), suiteConfigYaml(input));
  if (copyFrom) {
    const cases = listCases(cfg, copyFrom).map((c) => ({ description: c.description, fixture: c.fixture, assertions: c.assertions.map((a) => a.raw) }));
    if (cases.length) appendCases(cfg, name, cases);
  }
}

export function updateSuite(cfg: AppConfig, name: string, input: SuiteInput): void {
  const dir = requireUserSuite(cfg, name);
  if (!input.description.trim()) throw new Error('give the suite a description');
  const file = join(dir, 'promptfooconfig.yaml');
  writeFileSync(`${file}.bak`, readFileSync(file));
  writeFileSync(file, suiteConfigYaml(input));
}

/** Moves the suite aside instead of erasing it, so a mistaken delete can be undone by hand. */
export function deleteSuite(cfg: AppConfig, name: string): void {
  const dir = requireUserSuite(cfg, name);
  const trash = join(cfg.userSuitesDir, '.trash');
  mkdirSync(trash, { recursive: true });
  const tag = `${name}-${stamp()}`;
  const cases = privateFile(cfg, name);
  if (cfg.privateCasesDir && existsSync(cases)) renameSync(cases, `${cases}.deleted-${stamp()}`);
  renameSync(dir, join(trash, tag));
}
