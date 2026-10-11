import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as A from '../src/assertions.ts';
import { buildAssertion, CATALOG, parseAssertion } from '../src/app/catalog.ts';
import { checkAssertions, deleteCase, listCases, saveCase } from '../src/app/cases.ts';
import type { AppConfig } from '../src/app/config.ts';
import { guardWarnings, isLocalModel, windowWarnings } from '../src/app/guard.ts';
import { runConfig } from '../src/app/runs.ts';
import { basicAuthOk, credentialsFromEnv } from '../src/app/auth.ts';
import { summarize } from '../src/app/summarize.ts';

const at = (day: number, hhmm: string) => new Date(2026, 9, 11 + day, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)));

test('every catalog entry maps to a real assertion function', () => {
  for (const s of CATALOG) if (s.fn) assert.equal(typeof (A as Record<string, unknown>)[s.fn], 'function', s.fn);
});

test('buildAssertion and parseAssertion round-trip', () => {
  const a = buildAssertion('delegatedRefsPreserved', { listedIn: 'x', ordered: false, unique: true });
  assert.deepEqual(a.config, { listedIn: 'x', ordered: false });
  assert.deepEqual(parseAssertion(a), { id: 'delegatedRefsPreserved', values: { listedIn: 'x', refPattern: undefined, ordered: false, unique: true } });
  assert.deepEqual(buildAssertion('callsTool', { names: 'a, b' }).config, { names: ['a', 'b'] });
  assert.deepEqual(buildAssertion('maxLength', { max: '12' }).config, { max: 12 });
  assert.deepEqual(buildAssertion('icontains', { value: 'hi' }), { type: 'icontains', value: 'hi' });
  assert.throws(() => buildAssertion('callsTool', { names: [] }), /required/);
  assert.throws(() => buildAssertion('maxLength', { max: 'lots' }), /number/);
  assert.equal(parseAssertion({ type: 'llm-rubric', value: 'x' }), undefined);
});

test('windowWarnings: active, upcoming, other days', () => {
  const w = [{ label: 'digests', from: '06:00', to: '06:45' }, { label: 'weekly', days: [2], from: '09:00', to: '12:30' }];
  assert.equal(windowWarnings(w, at(0, '06:10'), 30).length, 1);
  assert.match(windowWarnings(w, at(0, '05:45'), 30)[0]!, /starts at 06:00, in 15 minutes/);
  assert.equal(windowWarnings(w, at(0, '03:00'), 30).length, 0);
  assert.equal(windowWarnings(w, at(0, '10:00'), 30).length, 0); // 2026-10-11 is a Sunday
  assert.equal(windowWarnings(w, at(2, '10:00'), 30).length, 1); // Tuesday
});

test('guardWarnings only concerns local models, and reads what Ollama has loaded', async () => {
  const price = { input: 0, output: 0 };
  const models = {
    local: { apiBaseUrl: 'http://localhost:11434/v1', model: 'qwen:27b', price },
    cloud: { apiBaseUrl: 'https://api.example.com/v1', model: 'big', price },
  };
  const cfg = { ollamaUrl: 'http://localhost:11434', busyWindows: [], lookaheadMinutes: 30 };
  const loaded = (names: string[]) => (async () => ({ json: async () => ({ models: names.map((name) => ({ name })) }) })) as unknown as typeof fetch;
  assert.deepEqual(await guardWarnings(models, ['cloud'], cfg, at(0, '12:00'), loaded(['x'])), []);
  assert.deepEqual(await guardWarnings(models, ['local'], cfg, at(0, '12:00'), loaded(['qwen:27b:latest'.replace(':latest', '')])), []);
  const w = await guardWarnings(models, ['local'], cfg, at(0, '12:00'), loaded(['other:70b']));
  assert.match(w[0]!, /other:70b loaded/);
  const down = await guardWarnings(models, ['local'], cfg, at(0, '12:00'), (async () => { throw new Error('refused'); }) as unknown as typeof fetch);
  assert.match(down[0]!, /Cannot reach Ollama/);
  assert.equal(isLocalModel(models.cloud, undefined), false);
  assert.equal(isLocalModel({ ...models.cloud, gpu: true }, undefined), true);
});

test('runConfig swaps providers and keeps the rest', () => {
  const out = runConfig('description: d\nproviders:\n  - id: x\ntests: file://cases*.yaml\n', ['@reference', 'm1']);
  assert.match(out, /tests: file:\/\/cases\*\.yaml/);
  assert.match(out, /label: m1/);
  assert.doesNotMatch(out, /id: x/);
});

test('summarize groups repeats and totals per model', () => {
  const row = (testIdx: number, label: string, success: boolean) => ({
    testIdx, provider: { label }, success, latencyMs: 100, cost: 0.5,
    testCase: { description: 't', vars: { fixture: 'f.json' } },
    response: { tokenUsage: { prompt: 10, completion: 2, cached: 4 }, output: { content: 'hi', tool_calls: [{ name: 'x', arguments: { a: 1 } }] } },
    gradingResult: { componentResults: success ? [] : [{ pass: false, reason: 'nope' }] },
  });
  const s = summarize({ evalId: 'e1', results: { results: [row(0, 'a', true), row(1, 'a', false), row(0, 'b', true), row(1, 'b', true)] } });
  assert.equal(s.tests.length, 1);
  assert.equal(s.tests[0]!.cells.a!.length, 2);
  assert.deepEqual(s.models.map((m) => [m.label, m.passed, m.total, m.cost, m.cachedTokens]), [['a', 1, 2, 1, 8], ['b', 2, 2, 1, 8]]);
  assert.equal(s.tests[0]!.cells.a![1]!.reason, 'nope');
});

test('cases: save, edit, delete, backup, and the recorded-answer check', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-app-'));
  mkdirSync(join(root, 'suites', 's1'), { recursive: true });
  writeFileSync(join(root, 'suites', 's1', 'promptfooconfig.yaml'), 'description: x\n');
  const cfg = { suitesDir: join(root, 'suites') } as AppConfig;
  const fx = join(root, 'f.json');
  writeFileSync(fx, JSON.stringify({ messages: [], reference: { message: { content: 'Medium digest', tool_calls: [{ function: { name: 'read_post', arguments: '{"ref":"T1"}' } }] } } }));
  const calls = buildAssertion('callsTool', { names: ['read_post'] });
  const text = buildAssertion('startsWith', { pattern: 'Medium' });
  assert.deepEqual(checkAssertions(fx, [calls, text, buildAssertion('avoidsTool', { names: ['read_post'] })]).map((r) => r.pass), [true, true, false]);

  saveCase(cfg, 's1', { description: 'one', fixture: 'f.json', assertions: [calls] });
  saveCase(cfg, 's1', { description: 'two', fixture: 'f.json', assertions: [text] });
  let cases = listCases(cfg, 's1');
  assert.deepEqual(cases.map((c) => [c.description, c.editable, c.assertions[0]!.id]), [['one', true, 'callsTool'], ['two', true, 'startsWith']]);
  saveCase(cfg, 's1', { description: 'two, edited', fixture: 'f.json', assertions: [text] }, 1);
  deleteCase(cfg, 's1', 0);
  cases = listCases(cfg, 's1');
  assert.deepEqual(cases.map((c) => c.description), ['two, edited']);
  const file = join(root, 'suites', 's1', 'cases.private.yaml');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /^\[/m); // block style, not [ { ... } ]
  assert.match(readFileSync(`${file}.bak`, 'utf8'), /two/); // the version before the last change
  assert.throws(() => deleteCase(cfg, 's1', 5), /no longer exists/);
  assert.throws(() => saveCase(cfg, '../x', { description: 'a', fixture: 'f', assertions: [calls] }), /unknown suite/);
  assert.throws(() => saveCase(cfg, 's1', { description: 'a', fixture: 'f', assertions: [] }), /at least one/);
});

test('runConfig appends private case files to the suite tests', () => {
  const one = runConfig('tests: file://cases*.yaml\n', ['m'], ['file:///data/s.yaml']);
  assert.match(one, /- file:\/\/cases\*\.yaml\n\s*- file:\/\/\/data\/s\.yaml/);
  assert.match(runConfig('description: x\n', ['m'], ['file:///data/s.yaml']), /tests:\n\s*- file:\/\/\/data\/s\.yaml/);
  assert.doesNotMatch(runConfig('tests: file://cases*.yaml\n', ['m']), /- file/);
});

test('basic auth: env parsing and header check', () => {
  assert.equal(credentialsFromEnv({}), undefined);
  assert.throws(() => credentialsFromEnv({ TRIALS_AUTH_USER: 'bill' }), /both/);
  const creds = credentialsFromEnv({ TRIALS_AUTH_USER: 'bill', TRIALS_AUTH_PASSWORD: 'p:ass' })!;
  const hdr = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
  assert.equal(basicAuthOk(hdr('bill:p:ass'), creds), true); // a colon in the password is fine
  assert.equal(basicAuthOk(hdr('bill:wrong'), creds), false);
  assert.equal(basicAuthOk(hdr('bob:p:ass'), creds), false);
  assert.equal(basicAuthOk(hdr('nocolon'), creds), false);
  assert.equal(basicAuthOk(undefined, creds), false);
  assert.equal(basicAuthOk('Bearer abc', creds), false);
});

test('private cases can live outside the suite directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-priv-'));
  mkdirSync(join(root, 'suites', 's1'), { recursive: true });
  writeFileSync(join(root, 'suites', 's1', 'promptfooconfig.yaml'), 'description: x\n');
  writeFileSync(join(root, 'suites', 's1', 'cases.yaml'), '- description: shipped\n  vars: { fixture: a.json }\n  assert: []\n');
  const cfg = { suitesDir: join(root, 'suites'), privateCasesDir: join(root, 'data', 'cases') } as AppConfig;
  const calls = buildAssertion('callsTool', { names: ['x'] });
  saveCase(cfg, 's1', { description: 'mine', fixture: 'f.json', assertions: [calls] });
  const cases = listCases(cfg, 's1');
  assert.deepEqual(cases.map((c) => [c.description, c.editable]), [['shipped', false], ['mine', true]]);
  assert.match(readFileSync(join(root, 'data', 'cases', 's1.yaml'), 'utf8'), /mine/);
});
