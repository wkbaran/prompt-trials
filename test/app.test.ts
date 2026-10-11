import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as A from '../src/assertions.ts';
import { buildAssertion, CATALOG, parseAssertion } from '../src/app/catalog.ts';
import { caseFiles, checkAssertions, deleteCase, listCases, requireSuite, saveCase } from '../src/app/cases.ts';
import type { AppConfig } from '../src/app/config.ts';
import { guardWarnings, isLocalModel, windowWarnings } from '../src/app/guard.ts';
import { runConfig } from '../src/app/runs.ts';
import { clusterRows, describeRun, listSpend, makeClient, timestampKey, toRecording } from '../src/litellm.ts';
import { importedPrefixes, importWindow, recentRuns } from '../src/app/litellm-runs.ts';
import { deleteRecordingDir, listRecordingDirs } from '../src/app/recordings.ts';
import { createSuite, deleteSuite, getSuite, listSuites, updateSuite } from '../src/app/suites.ts';
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
  const out = runConfig('description: d\nproviders:\n  - id: x\ntests: file://cases*.yaml\n', ['@reference', 'm1'], ['file://cases.yaml']);
  assert.match(out, /- file:\/\/cases\.yaml/);
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

test('runConfig lists the given case files, replacing the glob', () => {
  const out = runConfig('tests: file://cases*.yaml\n', ['m'], ['file://cases.yaml', 'file:///data/s.yaml']);
  assert.match(out, /- file:\/\/cases\.yaml\n\s*- file:\/\/\/data\/s\.yaml/);
  assert.doesNotMatch(out, /cases\*/);
  assert.match(runConfig('description: x\n', ['m'], ['file:///data/s.yaml']), /tests:\n\s*- file:\/\/\/data\/s\.yaml/);
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

test('suites made in the app: create, copy, edit, delete, and the shipped ones stay read-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-suites-'));
  mkdirSync(join(root, 'suites', 'shipped-one'), { recursive: true });
  writeFileSync(join(root, 'suites', 'shipped-one', 'promptfooconfig.yaml'), 'description: Shipped\ndefaultTest:\n  assert:\n    - { type: javascript, value: "file://../../src/assertions.ts:validToolArguments" }\n    - { type: not-icontains, value: oops }\ntests: file://cases*.yaml\n');
  writeFileSync(join(root, 'suites', 'shipped-one', 'cases.yaml'), '- description: a case\n  vars: { fixture: f.json }\n  assert:\n    - { type: icontains, value: hi }\n');
  const cfg = { suitesDir: join(root, 'suites'), userSuitesDir: join(root, 'user-suites'), privateCasesDir: join(root, 'cases') } as AppConfig;

  assert.deepEqual(listSuites(cfg).map((s) => [s.name, s.kind, s.cases]), [['shipped-one', 'shipped', 1]]);
  const shipped = getSuite(cfg, 'shipped-one');
  assert.deepEqual(shipped.defaultAssertions.map((a) => a.id), ['not-icontains']); // the always-on check is not listed

  createSuite(cfg, 'my-copy', { description: 'My copy', defaultAssertions: shipped.defaultAssertions.map((a) => a.raw) }, 'shipped-one');
  assert.deepEqual(listSuites(cfg).map((s) => [s.name, s.kind, s.cases]), [['my-copy', 'user', 1], ['shipped-one', 'shipped', 1]]);
  assert.match(readFileSync(join(root, 'user-suites', 'my-copy', 'promptfooconfig.yaml'), 'utf8'), /validToolArguments[\s\S]*oops/);
  assert.deepEqual(caseFiles(cfg, 'my-copy').map((f) => f.external), [true]);
  assert.equal(listCases(cfg, 'my-copy')[0]!.editable, true);

  updateSuite(cfg, 'my-copy', { description: 'Renamed', defaultAssertions: [] });
  assert.equal(getSuite(cfg, 'my-copy').description, 'Renamed');
  assert.deepEqual(getSuite(cfg, 'my-copy').defaultAssertions, []);

  assert.throws(() => updateSuite(cfg, 'shipped-one', { description: 'x', defaultAssertions: [] }), /read-only/);
  assert.throws(() => deleteSuite(cfg, 'shipped-one'), /read-only/);
  assert.throws(() => createSuite(cfg, 'my-copy', { description: 'again', defaultAssertions: [] }), /already exists/);
  assert.throws(() => createSuite(cfg, 'shipped-one', { description: 'again', defaultAssertions: [] }), /already exists/);
  assert.throws(() => createSuite(cfg, 'Bad Name', { description: 'x', defaultAssertions: [] }), /lowercase/);
  assert.throws(() => createSuite(cfg, '../escape', { description: 'x', defaultAssertions: [] }), /lowercase/);
  assert.throws(() => createSuite(cfg, 'blank', { description: ' ', defaultAssertions: [] }), /description/);
  assert.throws(() => requireSuite(cfg, '.trash'), /unknown suite/);

  deleteSuite(cfg, 'my-copy');
  assert.deepEqual(listSuites(cfg).map((s) => s.name), ['shipped-one']);
  assert.equal(existsSync(join(root, 'cases', 'my-copy.yaml')), false);
  assert.equal(readdirSync(join(root, 'user-suites', '.trash')).length, 1); // moved aside, not erased
  createSuite(cfg, 'my-copy', { description: 'Again', defaultAssertions: [] }); // the name is free again
});

test('hiding the shipped suites leaves only your own, and frees their names', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-hide-'));
  mkdirSync(join(root, 'suites', 'medium-digest'), { recursive: true });
  writeFileSync(join(root, 'suites', 'medium-digest', 'promptfooconfig.yaml'), 'description: Shipped\ntests: file://cases*.yaml\n');
  writeFileSync(join(root, 'suites', 'medium-digest', 'cases.yaml'), '- description: synthetic example\n  vars: { fixture: f.json }\n  assert: []\n');
  mkdirSync(join(root, 'cases'));
  writeFileSync(join(root, 'cases', 'medium-digest.yaml'), '- description: my real case\n  vars: { fixture: fixtures/medium-digest/x.json }\n  assert:\n    - { type: icontains, value: hi }\n');
  const cfg = { suitesDir: join(root, 'suites'), userSuitesDir: join(root, 'user-suites'), privateCasesDir: join(root, 'cases'), showShippedSuites: false } as AppConfig;
  assert.deepEqual(listSuites(cfg), []);
  createSuite(cfg, 'medium-digest', { description: 'Mine', defaultAssertions: [] }); // the same name, now free
  const [suite] = listSuites(cfg);
  assert.deepEqual([suite!.name, suite!.kind, suite!.cases], ['medium-digest', 'user', 1]);
  assert.deepEqual(listCases(cfg, 'medium-digest').map((c) => [c.description, c.editable]), [['my real case', true]]); // no synthetic example
});

const row = (id: string, startTime: string, over: Record<string, unknown> = {}) => ({ request_id: id, model: 'qwen', call_type: 'acompletion', prompt_tokens: 100, spend: 0.5, startTime, endTime: startTime, ...over });

/** A LiteLLM stand-in: serves rows from the list endpoint, and one stored request per row from the detail endpoint. */
function fakeProxy(rows: ReturnType<typeof row>[], firstUser = 'plain request') {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/spend/logs/ui') {
      const at = (p: string) => Date.parse(`${u.searchParams.get(p)!.replace(' ', 'T')}Z`);
      const inRange = rows.filter((r) => Date.parse(r.startTime) >= at('start_date') && Date.parse(r.startTime) <= at('end_date'));
      return { ok: true, json: async () => ({ data: u.searchParams.get('page') === '1' ? inRange.slice(0, 2) : inRange.slice(2), total_pages: 2 }) };
    }
    const r = rows.find((x) => x.request_id === u.searchParams.get('request_id'))!;
    return { ok: true, json: async () => [{ request_id: r.request_id, startTime: r.startTime.replace(/\.(\d{3})\+00:00$/, '.$1000Z'), status: 'success', request_duration_ms: 5, prompt_tokens: 100,
      proxy_server_request: { model: 'qwen', messages: [{ role: 'user', content: firstUser }], tools: [] },
      response: { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: {} } }] };
  }) as unknown as typeof fetch;
  return { client: makeClient('http://proxy', 'k', fetchImpl), calls };
}

test('litellm: paging, clustering, labels and what counts as an agent request', async () => {
  const rows = [row('a', '2026-10-11T12:00:00.000+00:00'), row('b', '2026-10-11T12:02:00.000+00:00'), row('c', '2026-10-11T12:15:00.000+00:00'),
    row('j', '2026-10-11T12:15:30.000+00:00', { model: 'jev' }), row('e', '2026-10-11T12:16:00.000+00:00', { call_type: 'aembedding' })];
  const { client } = fakeProxy(rows);
  const listed = await listSpend(client, new Date('2026-10-11T00:00:00Z'), new Date('2026-10-12T00:00:00Z'));
  assert.equal(listed.length, 5); // both pages read
  const clusters = clusterRows(listed.filter((r) => r.model !== 'jev' && !r.call_type!.includes('embedding')));
  assert.deepEqual(clusters.map((c) => c.rows.length), [2, 1]); // a 13 minute gap splits the runs
  assert.equal(describeRun([{ role: 'system', content: 'x' }, { role: 'user', content: 'foo [IMPORTANT: The user has invoked the "medium-digest" skill, indicating' }]), 'medium-digest');
  assert.equal(describeRun([{ role: 'user', content: 'You are a cron subagent reading Medium posts' }]), 'You are a cron subagent reading Medium posts');
  assert.equal(timestampKey('2026-10-11T12:00:07.057+00:00'), '2026-10-11T12-00-07-057'); // as the list endpoint gives it
  assert.equal(timestampKey('2026-10-11T12:00:07.057000Z'), '2026-10-11T12-00-07-057'); // as the stored request (and the file name) has it
  assert.equal(toRecording({ proxy_server_request: {} }), undefined);
});

test('recent runs are labelled and marked imported; importing writes recordings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-ll-'));
  const cfg = { recordingsDir: join(root, 'recordings') } as AppConfig;
  const rows = [row('a', '2026-10-11T12:00:00.000+00:00'), row('b', '2026-10-11T12:01:00.000+00:00'), row('c', '2026-10-11T12:30:00.000+00:00')];
  const { client } = fakeProxy(rows, 'x [IMPORTANT: The user has invoked the "substack-digest" skill, y');
  const now = new Date('2026-10-11T13:00:00Z');

  let runs = await recentRuns(cfg, client, 3, now);
  assert.deepEqual(runs.map((r) => [r.label, r.requests, r.imported]), [['substack-digest', 1, false], ['substack-digest', 2, false]]); // newest first
  assert.deepEqual(await importWindow(cfg, client, runs[1]!.start, runs[1]!.end, 'first-run'), { written: 2, skipped: 0 });
  assert.equal(readdirSync(join(root, 'recordings', 'first-run')).length, 2);
  assert.deepEqual([...importedPrefixes(cfg).values()], ['first-run', 'first-run']);

  runs = await recentRuns(cfg, client, 3, now);
  assert.deepEqual(runs.map((r) => [r.imported, r.importedAs]), [[false, undefined], [true, 'first-run']]);
  await assert.rejects(importWindow(cfg, client, '2026-10-11T12:00:00Z', '2026-10-11T12:01:00Z', '../escape'), /folder names/);
  await assert.rejects(importWindow(cfg, client, '2026-10-11T00:00:00Z', '2026-10-12T00:00:00Z', 'wide'), /not a single run/);
});

test('deleting a recordings folder removes only that folder, and the run can be imported again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-del-'));
  const cfg = { recordingsDir: join(root, 'recordings') } as AppConfig;
  const rows = [row('a', '2026-10-11T12:00:00.000+00:00'), row('b', '2026-10-11T12:01:00.000+00:00')];
  const { client } = fakeProxy(rows);
  await importWindow(cfg, client, '2026-10-11T12:00:00Z', '2026-10-11T12:01:00Z', 'keep-me');
  await importWindow(cfg, client, '2026-10-11T12:00:00Z', '2026-10-11T12:01:00Z', 'drop-me');
  assert.deepEqual(listRecordingDirs(cfg).map((d) => [d.name, d.files]).sort(), [['drop-me', 2], ['keep-me', 2]]);
  assert.equal(deleteRecordingDir(cfg, 'drop-me'), 2);
  assert.deepEqual(listRecordingDirs(cfg).map((d) => d.name), ['keep-me']);
  assert.throws(() => deleteRecordingDir(cfg, 'drop-me'), /no recordings/);
  assert.throws(() => deleteRecordingDir(cfg, '../recordings'), /bad recording directory/);
  assert.throws(() => deleteRecordingDir(cfg, '.'), /bad recording directory/);
  assert.equal(readdirSync(join(root, 'recordings', 'keep-me')).length, 2);
});
