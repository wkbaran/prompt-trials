import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { viewerProxy } from '../src/app/proxy.ts';
import { freePort } from './helpers.ts';

const creds = { user: 'bill', password: 'p:ass' };
const basic = `Basic ${Buffer.from('bill:p:ass').toString('base64')}`;
let web: Server;
let proxy: Server;
let proxyPort = 0;
let webPort = 0;
const upgraded: string[] = [];
let viewerSawClientLeave: Promise<void> = Promise.resolve();
const open = new Set<Duplex>(); // upgraded connections are not tracked by closeAllConnections, so teardown ends them itself

before(async () => {
  // The "viewer": a plain HTTP server that echoes what it was asked, and a raw socket server for upgrades.
  webPort = await freePort();
  web = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res.writeHead(201, { 'x-from': 'viewer' }).end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') })));
  });
  // The same server also takes websocket upgrades: it answers 101, says pong, then echoes whatever arrives.
  web.on('upgrade', (req, socket) => {
    open.add(socket);
    upgraded.push(`${req.method} ${req.url} HTTP/${req.httpVersion}`);
    viewerSawClientLeave = new Promise((r) => socket.on('end', () => r()));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\npong-from-viewer');
    socket.on('data', (d) => socket.write(`echo:${d.toString('utf8')}`));
    socket.on('end', () => socket.end()); // like a real websocket server, answer a close with a close
  });
  await new Promise<void>((r) => web.listen(webPort, '127.0.0.1', r));

  proxyPort = await freePort();
});

after(() =>
  Promise.all(
    [web, proxy].map((s) => {
      for (const sock of open) sock.destroy();
      s?.closeAllConnections();
      return new Promise<void>((r) => s?.close(() => r()));
    }),
  ),
);

test('without a login configured the proxy just forwards', async () => {
  const plain = viewerProxy('127.0.0.1', proxyPort, webPort);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/eval/abc?x=1`, { method: 'POST', body: 'hello' });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-from'), 'viewer');
    assert.deepEqual(await res.json(), { method: 'POST', url: '/eval/abc?x=1', body: 'hello' });
  } finally {
    await new Promise<void>((r) => plain.close(() => r()));
  }
});

test('with a login, requests need it and carry through when they have it', async () => {
  proxy = viewerProxy('127.0.0.1', proxyPort, webPort, creds);
  const url = `http://127.0.0.1:${proxyPort}/api/results`;
  const denied = await fetch(url);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate') ?? '', /^Basic realm=/);
  assert.equal((await fetch(url, { headers: { authorization: `Basic ${Buffer.from('bill:nope').toString('base64')}` } })).status, 401);
  const ok = await fetch(url, { headers: { authorization: basic } });
  assert.equal(ok.status, 201);
  assert.equal(((await ok.json()) as any).url, '/api/results');
});

test('a viewer that is down gives a 502, not a hang', async () => {
  const deadPort = await freePort();
  const p = await freePort();
  const down = viewerProxy('127.0.0.1', p, deadPort, creds);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/`, { headers: { authorization: basic } });
    assert.equal(res.status, 502);
  } finally {
    await new Promise<void>((r) => down.close(() => r()));
  }
});

const upgrade = (auth?: string) =>
  new Promise<string>((resolve) => {
    const sock = connect(proxyPort, '127.0.0.1', () =>
      sock.write(`GET /socket.io/?x=1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${auth ? `Authorization: ${auth}\r\n` : ''}\r\n`),
    );
    let got = '';
    setTimeout(() => {
      sock.destroy();
      resolve(got); // whatever arrived by now; the assertions say what was missing
    }, 3000).unref();
    sock.on('data', (d) => {
      got += d.toString('utf8');
      if (auth && got.includes('pong-from-viewer') && !got.includes('echo:')) sock.write('ping');
      if (!auth || got.includes('echo:ping')) {
        sock.destroy();
        resolve(got);
      }
    });
    sock.on('close', () => resolve(got));
  });

test('websocket upgrades are refused without the login and piped both ways with it', async () => {
  assert.match(await upgrade(), /^HTTP\/1\.1 401/);
  assert.equal(upgraded.length, 0); // the viewer never saw the unauthenticated attempt
  const got = await upgrade(basic);
  assert.match(got, /101 Switching Protocols/);
  assert.match(got, /pong-from-viewer/);
  assert.match(got, /echo:ping/);
  assert.match(upgraded[0]!, /^GET \/socket\.io\/\?x=1 HTTP\/1\.1/);
  // The client has gone: the viewer must be told, so it can free the connection.
  await Promise.race([viewerSawClientLeave, new Promise((_, no) => setTimeout(() => no(new Error('the viewer was never told the client left')), 2000))]);
});
