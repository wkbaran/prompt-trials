import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { basicAuthOk, CHALLENGE, type Credentials } from './auth.ts';

/**
 * Listens on `port` and forwards everything to the viewer on 127.0.0.1:`target`, after checking the
 * login when there is one. WebSocket upgrades are piped through.
 */
export function viewerProxy(host: string, port: number, target: number, creds?: Credentials): Server {
  const allowed = (req: IncomingMessage) => !creds || basicAuthOk(req.headers.authorization, creds);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!allowed(req)) {
      res.writeHead(401, CHALLENGE).end('login required');
      return;
    }
    const upstream = httpRequest({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('the results viewer is not running');
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!allowed(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Prompt Trials"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const up = connect(target, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  server.listen(port, host);
  return server;
}
