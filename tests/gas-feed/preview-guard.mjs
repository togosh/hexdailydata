// The Node/API/browser path is literal-loopback only. Public HTTPS is confined
// to the independently bound Python gas worker, never this process or a visitor.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dnp from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
const no = () => {
  throw Error('GAS_PREVIEW_NON_LOOPBACK_BLOCKED');
};
for (const m of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse', 'resolveAny']) {
  dns[m] = no;
  dnp[m] = no;
}
dns.lookup = (host, options, callback) => {
  if (host !== '127.0.0.1') no();
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  queueMicrotask(() =>
    options?.all ? callback(null, [{ address: host, family: 4 }]) : callback(null, host, 4),
  );
};
dnp.lookup = async (host, options) => {
  if (host !== '127.0.0.1') no();
  return options?.all ? [{ address: host, family: 4 }] : { address: host, family: 4 };
};
tls.connect = no;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (!o || typeof o !== 'object' || o.host !== '127.0.0.1') no();
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const u = new URL(input instanceof Request ? input.url : input);
  if (u.hostname !== '127.0.0.1' || u.protocol !== 'http:' || u.username || u.password) no();
  return fetch(input, { ...options, redirect: 'error' });
};
syncBuiltinESMExports();
