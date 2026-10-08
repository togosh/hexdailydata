// One finite local inbox + checkpoint transaction. No notification side effects.
import {
  readFileSync,
  existsSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { StakeEventsResponseSchema as Response } from '../../dist/contracts/stake-events.js';
const options = JSON.parse(process.env.LAB_CONSUMER_OPTIONS);
const base = new URL(options.base);
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw Error('Loopback only');
let state = existsSync(options.file)
  ? JSON.parse(readFileSync(options.file, 'utf8'))
  : { version: 1, selection: options.query, inbox: {}, cursor: null };
if (JSON.stringify(state.selection) !== JSON.stringify(options.query))
  throw Error('Client selection changed; explicit reset required');
if (options.reset)
  state = {
    version: 1,
    selection: options.query,
    inbox: {},
    cursor: null,
    resetAcknowledged: true,
  };
const receipt = {
  pid: process.pid,
  simulatedNow: process.env.LAB_NOW,
  attempts: [],
  commits: [],
  notifications: [],
  status: 'INCOMPLETE',
};
function saveReceipt() {
  writeFileSync(options.receipt, JSON.stringify(receipt, null, 2) + '\n');
}
function commit(next) {
  const temporary = options.file + '.pending';
  const fd = openSync(temporary, 'w');
  writeFileSync(fd, JSON.stringify(next) + '\n');
  fsyncSync(fd);
  closeSync(fd);
  if (options.fault === 'before-rename') {
    saveReceipt();
    process.exit(18);
  }
  renameSync(temporary, options.file);
  const dir = openSync(dirname(options.file), 'r');
  fsyncSync(dir);
  closeSync(dir);
}
try {
  for (let request = 0; request < Math.min(options.maxRequests ?? 30, 30); request++) {
    const query = { ...options.query, ...(state.cursor ? { cursor: state.cursor } : {}) };
    const response = await fetch(
      new URL('/api/v2/stake-events?' + new URLSearchParams(query), base),
      {
        redirect: 'error',
        signal: AbortSignal.timeout(6000),
      },
    );
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 524288) throw Error('Response bound');
    const body = JSON.parse(raw);
    receipt.attempts.push({ query, status: response.status, bytes: Buffer.byteLength(raw) });
    if (response.status !== 200) {
      receipt.status = body.error.code === 'reset_required' ? 'RESET_REQUIRED' : 'STOPPED';
      receipt.error = body.error;
      break;
    }
    Response.parse(body);
    if (options.fault === 'after-receive') {
      saveReceipt();
      process.exit(17);
    }
    const next = structuredClone(state),
      fresh = [];
    for (const e of body.items) {
      if (!next.inbox[e.eventId]) fresh.push(e);
      next.inbox[e.eventId] = e;
    }
    if (Object.keys(next.inbox).length > 5000) throw Error('Local demo inbox cap');
    if (!body.caughtUp && body.nextCursor === state.cursor) throw Error('No-progress page');
    next.cursor = body.nextCursor;
    next.caughtUp = body.caughtUp;
    next.cutoff = body.cutoff;
    commit(next);
    state = next;
    receipt.commits.push({
      items: body.items.length,
      newItems: fresh.length,
      inbox: Object.keys(state.inbox).length,
      cursor: state.cursor,
      caughtUp: body.caughtUp,
    });
    if (options.fault === 'after-rename') {
      saveReceipt();
      process.exit(19);
    }
    for (const e of fresh) {
      const line = `stake ${e.stakeId} ${e.kind === 'stake_start' ? 'started' : e.kind === 'good_accounting' ? 'Good-Accounted' : 'ended'} (${e.eventId})`;
      receipt.notifications.push(line);
      console.log(line);
    }
    if (body.caughtUp) {
      receipt.status = 'CAUGHT_UP';
      break;
    }
  }
} catch (e) {
  receipt.status = 'STOPPED';
  receipt.error = { message: e.message };
  process.exitCode = 1;
} finally {
  saveReceipt();
}
