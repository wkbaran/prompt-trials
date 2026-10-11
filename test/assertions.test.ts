import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callsTool, delegatedRefsPreserved, noTemplateMarkers, noRepeatedItems, unwrap, validToolArguments } from '../src/assertions.ts';
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
