// Actual runRefresh orchestration with an explicitly injected finite stdio fixture.
// No worker process or provider implementation is executed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join, dirname, basename, resolve } from 'node:path';
import { fresh, receipt, hash, root, syntheticProtocol } from './helpers.mjs';
import { runProtocol as runRefresh } from '../../scripts/protocol-feed.mjs';
import { auditJournal, inspectStorage } from '../../dist/services/product-daily/storage.js';
const now = Date.now;
Date.now = () => Date.parse('2026-11-01T00:00:00Z');
const evidence = syntheticProtocol;
const awaitFixtureText = JSON.stringify(evidence);
const awaitFixtureUpdate = await fs.readFile(join(evidence.root, 'ROUND_1_UPDATE.json'));
const awaitFixtureAudit = await fs.readFile(join(evidence.root, 'ROUND_1_AUDIT.json'));
const awaitFixtureSample = await fs.readFile(join(evidence.root, 'ROUND_1_SAMPLE.json'));
const outcomes = [];
try {
  for (const failure of [true, false]) {
    const s = await fresh(failure ? 'driver-uncertain' : 'driver-settled'),
      parent = dirname(s.root),
      output = join(parent, 'capture');
    const profilePath = join(parent, 'profile.json'),
      preflightPath = join(parent, 'preflight.json');
    const profile = {
      productRoot: s.root,
      pair: s.capture().metadata.pair,
    };
    const p = Buffer.from(JSON.stringify(profile));
    await fs.writeFile(profilePath, p);
    await fs.writeFile(
      preflightPath,
      JSON.stringify({
        verdict: 'PASS',
        feed: 'protocol',
        synthetic: true,
        profileSha256: hash(p),
        trialRoot: output,
        profilePath,
        productRoot: s.root,
        acceptedProductRoot: join(parent, 'UNREAD-accepted'),
        runtimeFiles: {},
        seedVersion: s.capture().version,
      }),
    );
    const beforeState = JSON.parse(await fs.readFile(join(s.root, 'STORAGE.json')));
    const before = await fs.readFile(join(s.root, 'CURRENT.json')),
      rename = fs.rename;
    let launches = 0,
      closes = 0;
    if (failure) {
      fs.rename = async (from, to) => {
        if (resolve(to) === join(s.root, 'CURRENT.json')) throw Error('SYNTHETIC_POINTER_RENAME');
        return rename(from, to);
      };
      syncBuiltinESMExports();
    }
    let result;
    try {
      result = await runRefresh(
        { mode: 'once', profilePath, output, preflightPath },
        {
          testLaunchCollector: () => {
            launches++;
            const c = new EventEmitter();
            c.stdin = new PassThrough();
            c.stdout = new PassThrough();
            c.stderr = new PassThrough();
            c.pid = 999999;
            const evidence = JSON.parse(awaitFixtureText),
              source = evidence.root;
            const raw = awaitFixtureUpdate,
              auditRaw = awaitFixtureAudit;
            let stage = 0;
            const write = async (n, v) => fs.writeFile(join(output, n), JSON.stringify(v) + '\n');
            const send = (v) => c.stdout.write(JSON.stringify(v) + '\n');
            c.stdin.on('data', (b) => {
              void (async () => {
                const ack = JSON.parse(b.toString());
                if (stage++ === 0) {
                  assert(ack.ok);
                  send({
                    type: 'qualified',
                    cycle: 1,
                    update: 'ROUND_1_UPDATE.json',
                    updateSha256: hash(raw),
                    auditSha256: hash(auditRaw),
                    pin: JSON.parse(auditRaw).details.context,
                    sealedAt: new Date().toISOString(),
                    expiresAtUnixSeconds: Date.now() / 1000 + 29,
                  });
                } else {
                  assert.equal(ack.ok, !failure);
                  const accounting = {
                    mode: 'SYNTHETIC_OFFLINE_TEST',
                    status: 'CLOSED',
                    pending: null,
                    storageChargedBytes: 5000,
                  };
                  const final = {
                    status: failure ? 'PARTIAL' : 'COMPLETE_FINITE_TRIAL',
                    rounds: failure ? 0 : 1,
                    accounting,
                  };
                  await write('ACCOUNTING.json', accounting);
                  await write('RESULT.json', final);
                  send({ type: 'closed', result: final });
                  c.stdout.end();
                  c.stderr.end();
                  setImmediate(() => {
                    closes++;
                    c.emit('close', failure ? 2 : 0, null);
                  });
                }
              })().catch((e) => {
                c.stdout.destroy(e);
                c.emit('error', e);
                c.emit('close', 2, null);
              });
            });
            setImmediate(() => {
              void (async () => {
                await fs.mkdir(output);
                await fs.writeFile(join(output, 'ROUND_1_UPDATE.json'), raw);
                await fs.writeFile(join(output, 'ROUND_1_AUDIT.json'), auditRaw);
                await fs.writeFile(join(output, 'ROUND_1_SAMPLE.json'), awaitFixtureSample);
                await write('ACCOUNTING.json', {
                  mode: 'SYNTHETIC_OFFLINE_TEST',
                  status: 'SYNTHETIC_OFFLINE_TEST',
                  pending: null,
                });
                send({ type: 'begin', cycle: 1 });
              })().catch((e) => c.emit('error', e));
            });
            return c;
          },
        },
      );
    } finally {
      fs.rename = rename;
      syncBuiltinESMExports();
    }
    assert.equal(launches, 1);
    assert.equal(closes, 1);
    const st = JSON.parse(await fs.readFile(join(s.root, 'STORAGE.json')));
    if (failure) {
      assert.equal(result.status, 'PARTIAL');
      assert.equal(result.collector.accounting.status, 'CLOSED');
      assert.equal(result.captureStorage, null);
      assert.deepEqual(await fs.readFile(join(s.root, 'CURRENT.json')), before);
      assert((await fs.lstat(join(s.root, 'SELECTION.lock'))).isFile());
      assert((await fs.lstat(join(s.root, 'MARKET_REFRESH.lock'))).isFile());
      assert.equal(st.operationBytes, beforeState.operationBytes + 1024 ** 3 + 4096);
      assert.equal((await inspectStorage(s.root)).status, 'BLOCKED');
    } else {
      assert.equal(result.status, 'COMPLETE_FINITE_TRIAL');
      assert(result.captureStorage);
      assert.equal(st.operationSequence, beforeState.operationSequence + 2);
      await assert.rejects(fs.lstat(join(s.root, 'SELECTION.lock')), /ENOENT/);
      await assert.rejects(fs.lstat(join(s.root, 'MARKET_REFRESH.lock')), /ENOENT/);
      assert.equal((await auditJournal(s.root)).sequence, beforeState.sequence + 1);
    }
    outcomes.push({
      failure,
      root: s.root,
      result,
      launches,
      closes,
      operationBytes: st.operationBytes,
    });
  }
  await receipt('DRIVER_' + basename(dirname(outcomes[0].root)), {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    actualRunRefresh: true,
    childTransport: 'injected in-process stdio fixture',
    outcomes,
  });
  console.log('PASS actual driver known-closed uncertainty and settlement');
} finally {
  Date.now = now;
}
