// Test-only preload: all DNS and non-literal-loopback sockets fail before dispatch.
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => {
  throw Error('TEST_EXTERNAL_NETWORK_DENIED');
};
const allowed = (h) => h === '127.0.0.1' || h === '::1';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : args[1];
  if (!allowed(host)) return deny();
  return connect.apply(this, args);
};
tls.connect = deny;
dns.lookup = (host, options, callback) => {
  if (!allowed(host)) return deny();
  const cb = typeof options === 'function' ? options : callback;
  const family = host === '::1' ? 6 : 4;
  queueMicrotask(() =>
    options?.all ? cb(null, [{ address: host, family }]) : cb(null, host, family),
  );
};
dns.promises.lookup = deny;
for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']) {
  dns[name] = deny;
  dns.promises[name] = deny;
}
const fetch = globalThis.fetch;
globalThis.fetch = (input, ...rest) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || !allowed(url.hostname)) return deny();
  return fetch(input, ...rest);
};
syncBuiltinESMExports();
