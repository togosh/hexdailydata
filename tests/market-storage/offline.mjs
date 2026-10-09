// Installed before any application imports. Literal-loopback sockets only; DNS always blocked.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dnp from 'node:dns/promises';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const no = () => {
  throw Error('OFFLINE_NETWORK_OR_CHILD_BLOCKED');
};
for (const m of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse', 'resolveAny']) {
  dns[m] = no;
  dnp[m] = no;
}
// Node's listen path calls lookup even for a literal. Resolve that literal locally
// without ever calling the DNS implementation.
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
globalThis.fetch = no;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (!options || typeof options !== 'object' || options.host !== '127.0.0.1') no();
  return connect.apply(this, args);
};
for (const m of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'])
  cp[m] = no;
syncBuiltinESMExports();
