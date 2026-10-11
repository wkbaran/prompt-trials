// Preload (node --import) that makes every HTTP server in the process listen on 127.0.0.1 only.
// promptfoo's viewer has no host option and listens on all interfaces; the app starts it with this
// shim and serves it to the network through its own authenticated proxy.
import http from 'node:http';

const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number' || typeof args[0] === 'string') {
    // listen(port[, backlog][, cb]) -> listen(port, '127.0.0.1'[, backlog][, cb])
    if (typeof args[1] !== 'string') args.splice(1, 0, '127.0.0.1');
  }
  return listen.apply(this, args);
};
