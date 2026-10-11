import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNode } from './helpers.ts';

/** The frontend is plain browser JavaScript with no build step, so these checks catch what a build would. */
const pub = new URL('../src/app/public/', import.meta.url).pathname;
const read = (f: string) => readFileSync(join(pub, f), 'utf8');

test('every frontend script parses', async () => {
  for (const f of readdirSync(pub).filter((n) => n.endsWith('.js'))) {
    const { code, out } = await runNode(['--check', join(pub, f)]);
    assert.equal(code, 0, `${f}: ${out}`);
  }
});

test('index.html only refers to files that exist', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href)="\/([\w.-]+)"/g)].map((m) => m[1]!);
  assert.ok(refs.includes('app.js') && refs.includes('style.css') && refs.includes('palette.js'));
  for (const r of refs) assert.ok(existsSync(join(pub, r)), `missing ${r}`);
});

test('every API path the page calls is a route the server has', () => {
  const server = readFileSync(new URL('../src/app/server.ts', import.meta.url), 'utf8');
  const routes = new Set([...server.matchAll(/a === '([a-z]+)'/g)].map((m) => m[1]!));
  assert.ok(routes.size >= 8, `found only ${[...routes]}`);
  const app = read('app.js');
  const used = new Set([...app.matchAll(/\bapi\(\s*[`'"]([a-z]+)/g)].map((m) => m[1]!));
  for (const m of app.matchAll(/\/api\/([a-z]+)/g)) used.add(m[1]!);
  assert.ok(used.size >= 8, `found only ${[...used]}`);
  for (const u of used) assert.ok(routes.has(u), `the page calls /api/${u} but the server has no such route`);
});

test('the saved theme and palette use the keys the inline script and palette.js read', () => {
  assert.match(read('index.html'), /localStorage\.getItem\("prompt-trials\.theme"\)/);
  assert.match(read('app.js'), /THEME_KEY = 'prompt-trials\.theme'/);
  assert.match(read('palette.js'), /KEY = "prompt-trials\.palette"/);
  assert.match(read('index.html'), /data-palette="#[0-9a-f]{6},#[0-9a-f]{6},#[0-9a-f]{6}"/i);
});
