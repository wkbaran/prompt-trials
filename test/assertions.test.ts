import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callsTool, delegatedRefsPreserved, delimitedLines, goalIncludes, onlyOfferedTools, noTemplateMarkers, noRepeatedItems, unwrap, validToolArguments } from '../src/assertions.ts';
import { computeCost } from '../src/cost.ts';

const out = (calls: { name: string; arguments: unknown }[], content = '') => ({ content, tool_calls: calls });

function fixture(messages: unknown[]) {
  const p = join(mkdtempSync(join(tmpdir(), 'pt-')), 'f.json');
  writeFileSync(p, JSON.stringify({ messages }));
  return { vars: { fixture: p } };
}

test('unwrap tool_call wrapper', () => {
  const [c] = unwrap([{ name: 'tool_call', arguments: { name: 'read_post', arguments: { ref: 'F3' } } }]);
  assert.deepEqual(c, { name: 'read_post', arguments: { ref: 'F3' } });
});

test('unwrap batch wrapper and MCP prefix', () => {
  const calls = unwrap([
    { name: 'tool_call', arguments: { calls: [{ name: 'mcp__medium_reader__digest_finish', arguments: { a: 1 } }, { name: 'read_post', arguments: {} }] } },
    { name: 'delegate_task', arguments: {} },
  ]);
  assert.deepEqual(calls.map((c) => c.name), ['digest_finish', 'read_post', 'delegate_task']);
  assert.deepEqual(calls[0].arguments, { a: 1 });
});

test('callsTool sees wrapped calls', () => {
  const o = out([{ name: 'tool_call', arguments: { name: 'read_post', arguments: {} } }]);
  assert.equal(callsTool(o, { config: { names: ['read_post'] } }).pass, true);
  assert.equal(callsTool(o, { config: { names: ['digest_finish'] } }).pass, false);
});

test('validToolArguments flags unparsed JSON', () => {
  assert.equal(validToolArguments(out([{ name: 'x', arguments: { __unparsed: '{bad' } }])).pass, false);
  assert.equal(validToolArguments(out([{ name: 'x', arguments: { a: 1 } }])).pass, true);
});

test('validToolArguments: wrapper calls as a string must be a JSON list', () => {
  const finish = { name: 'mcp__s__discovery_finish', arguments: { lane: 'a' } };
  const string = (calls: string, extra = {}) => out([{ name: 'tool_call', arguments: { calls, ...extra } }]);
  // what a model once sent: a broken string, with the tool name left beside it
  assert.equal(validToolArguments(string('[{"arguments":{"why":{"K1":"it\'s \\u0026 \"x\" y"}', { name: finish.name })).pass, false);
  // a string holding a real JSON list is accepted by the wrapper, and unwrap reads through it
  const listed = string(JSON.stringify([finish]));
  assert.equal(validToolArguments(listed).pass, true);
  assert.deepEqual(unwrap(listed.tool_calls).map((c) => c.name), ['discovery_finish']);
});

test('delegatedRefsPreserved: ok, reordered, unknown', () => {
  const ctx = {
    ...fixture([{ role: 'tool', content: 'Posts: P1, P2, P3, P4' }]),
    config: {},
  };
  const goal = (g: string) => out([{ name: 'delegate_task', arguments: { tasks: [{ goal: g }] } }]);
  assert.equal(delegatedRefsPreserved(goal('Read P1 P2 P3'), ctx).pass, true);
  assert.equal(delegatedRefsPreserved(goal('Read P2 P3 P1'), ctx).pass, false);
  assert.equal(delegatedRefsPreserved(goal('Read P9'), ctx).pass, false);
});

test('noRepeatedItems', () => {
  const ctx = {
    ...fixture([
      { role: 'assistant', tool_calls: [{ function: { name: 'add_items', arguments: '{"uris":["a","b"]}' } }] },
    ]),
    config: { name: 'add_items', key: 'uris' },
  };
  assert.equal(noRepeatedItems(out([{ name: 'add_items', arguments: { uris: ['c'] } }]), ctx).pass, true);
  assert.equal(noRepeatedItems(out([{ name: 'add_items', arguments: { uris: ['b', 'c'] } }]), ctx).pass, false);
});

test('computeCost splits cached and fresh prompt tokens', () => {
  const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const c = computeCost(price, { promptTokens: 1_000_000, completionTokens: 100_000, cacheReadTokens: 800_000, cacheWriteTokens: 100_000 });
  // fresh 100k*3 + read 800k*0.3 + write 100k*3.75 + out 100k*15 = 0.3 + 0.24 + 0.375 + 1.5
  assert.ok(Math.abs(c - 2.415) < 1e-9, String(c));
});

test('delegatedRefsPreserved: listedIn and ordered:false', () => {
  const ctx = {
    ...fixture([
      { role: 'tool', content: 'describe: refs like P1, P2' },
      { role: 'tool', content: 'digest_begin: P2 P1 P3' },
    ]),
  };
  const o = out([{ name: 'delegate_task', arguments: { tasks: [{ goal: 'Read P1 P2' }] } }]);
  assert.equal(delegatedRefsPreserved(o, { ...ctx, config: { listedIn: 'digest_begin' } }).pass, false);
  assert.equal(delegatedRefsPreserved(o, { ...ctx, config: { listedIn: 'digest_begin', ordered: false } }).pass, true);
});

test('noTemplateMarkers', () => {
  const goal = (g: string) => out([{ name: 'delegate_task', arguments: { tasks: [{ goal: g }] } }]);
  assert.equal(noTemplateMarkers(goal('Return REF: <the ref> and a gist'), {}).pass, false);
  assert.equal(noTemplateMarkers(goal('Read F1 and F2; use {chat id}'), {}).pass, false);
  assert.equal(noTemplateMarkers(goal('Read F1 and F2; arguments {"a":1}'), {}).pass, true);
});

test('delegatedRefsPreserved reads refs out of JSON-escaped results', () => {
  const ctx = { ...fixture([{ role: 'tool', content: '{"result": "Work list\\nF25 | 99 | a\\nF1 | 98 | b"}' }]), config: {} };
  const o = out([{ name: 'delegate_task', arguments: { tasks: [{ goal: 'Read F25, F1' }] } }]);
  assert.equal(delegatedRefsPreserved(o, ctx).pass, true);
});

test('goalIncludes: every goal must carry every string', () => {
  const delegate = (goal: string) => out([{ name: 'delegate_task', arguments: { tasks: [{ goal }] } }]);
  const config = { includes: ['Lane id: b-ukg', 'verify_tracks'] };
  assert.equal(goalIncludes(delegate('Lane id: b-ukg. Hand them over with VERIFY_TRACKS.'), { config }).pass, true);
  assert.match(goalIncludes(delegate('Lane id: b-ukg. Reply DONE.'), { config }).reason, /verify_tracks/);
  assert.equal(goalIncludes(out([]), { config }).pass, false);
});

test('delimitedLines: field count, labels, JSON, fences, numbering, forbidden phrases', () => {
  const verify = (text: unknown) => out([{ name: 'tool_call', arguments: { calls: [{ name: 'mcp__spotify_discovery__verify_tracks', arguments: { lane: 'a', text } }] } }]);
  const config = { tool: 'verify_tracks', arg: 'text', fields: 7, exempt: ['LABEL |'], forbid: ['sounds like'] };
  const row = 'A | T | R | L | 2026-10-01 | Bandcamp: "dark" | https://x.example';
  assert.equal(delimitedLines(verify(`${row}\nLABEL | L | https://l.example | small label`), { config }).pass, true);
  assert.match(delimitedLines(verify('A | T | R | L | 2026-10-01 | why'), { config }).reason, /6 fields/);
  assert.match(delimitedLines(verify(`[{"artist":"A"}]`), { config }).reason, /JSON/);
  assert.match(delimitedLines(verify('```\n' + row + '\n```'), { config }).reason, /fence/);
  assert.match(delimitedLines(verify('1. ' + row), { config }).reason, /numbered/);
  assert.match(delimitedLines(verify(row.replace('dark', 'sounds like Noisia')), { config }).reason, /forbidden/);
  // nothing to check (e.g. the structured `candidates` alternative was used instead of `text`)
  assert.equal(delimitedLines(verify(undefined), { config }).pass, false);
});

test('onlyOfferedTools: names must be in the fixture tools', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'pt-')), 'f.json');
  writeFileSync(p, JSON.stringify({ messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }, { type: 'function', function: { name: 'tool_call' } }] }));
  const ctx = { vars: { fixture: p } };
  assert.equal(onlyOfferedTools(out([{ name: 'web_search', arguments: {} }, { name: 'tool_call', arguments: {} }]), ctx).pass, true);
  assert.match(onlyOfferedTools(out([{ name: 'terminal', arguments: {} }]), ctx).reason, /terminal.*not offered/);
  assert.equal(onlyOfferedTools(out([{ name: 'x', arguments: {} }]), { vars: {} }).pass, false);
  assert.equal(onlyOfferedTools(out([]), ctx).pass, true); // a text reply calls nothing
});
