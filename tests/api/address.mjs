import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { ReadDatabase } from '../../dist/services/queries/database.js';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { SqlAddressBaseline } from '../../dist/services/live/baseline.js';
import { dayDate } from '../../src/web/format.ts';
import { createApp } from '../../dist/api/app.js';
import { sqlBaseline } from '../../dist/api/dependencies.js';
const db = new ReadDatabase(databaseConfig('api'));
const app = createApp({ dependencies: { db }, now: () => Date.parse('2026-09-19T12:00:00Z') });
const address = '0x' + '1'.padStart(40, '0');
const checks = [];
const measurements = [];
async function get(path, status = 200) {
  const started = performance.now();
  const r = await app.inject('/api/v2' + path);
  measurements.push({
    route: path.split('?')[0].startsWith('/addresses/') ? 'address' : 'stakes',
    status: r.statusCode,
    ms: performance.now() - started,
    bytes: Buffer.byteLength(r.body),
  });
  assert.equal(r.statusCode, status, r.body);
  return r.json();
}
try {
  const result = await get('/addresses/' + address);
  assert.equal(result.live, null);
  const s = result.indexed.staking;
  assert.equal(s.openCount, '24');
  assert.equal(s.goodAccountedCount, '3');
  assert.equal(s.endedCount, '5');
  assert.equal(s.lockedHearts, '472500000000000'); // sum(1..27) * 12,500 HEX
  assert.equal(s.goodAccountedHearts, '97500000000000'); // (25+26+27) * 12,500 HEX
  assert.equal(s.accountedShares, '1200000000000000'); // sum(1..24) * 4 T-Shares
  assert.equal(s.firstStakeDay, 1100);
  assert.equal(dayDate(s.firstStakeDay), '2022-12-07');
  assert.equal(s.nextMaturityDay, s.contractDay + 66);
  checks.push(
    'Complete principal includes GA; shares exclude GA; 24/3/5 lifecycle counts; earliest start and future open maturity',
  );
  assert.equal(s.activity.length, 5);
  assert.deepEqual(
    s.activity.slice(0, 3).map((e) => e.kind),
    ['end', 'end', 'end'],
  );
  checks.push(
    'Lifecycle activity has five events ordered by canonical block/log, with end distinct from cancellation',
  );
  let path = '/stakes?address=' + address + '&lifecycle=open&limit=20';
  const first = await get(path);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].status, 'queued');
  assert.equal(first.items[1].status, 'mature_open');
  assert.equal(first.items[2].status, 'open');
  const second = await get(path + '&cursor=' + first.nextCursor);
  assert.equal(second.items.length, 4);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((e) => e.stakeId)).size, 24);
  await get(
    '/stakes?address=' + address + '&lifecycle=ended&limit=20&cursor=' + first.nextCursor,
    409,
  );
  const ga = await get('/stakes?address=' + address + '&lifecycle=good_accounted');
  assert.equal(ga.items.length, 3);
  assert.ok(ga.items.every((e) => e.status === 'good_accounted'));
  const ended = await get('/stakes?address=' + address + '&lifecycle=ended');
  assert.equal(ended.items.length, 5);
  assert.equal(ended.items.filter((e) => e.status === 'cancelled').length, 2);
  await get('/stakes?lifecycle=claimed', 400);
  checks.push(
    'Real API filtering across keyset pages, bound cursor rejection, queued/mature-open/GA/cancelled definitions',
  );
  const missing = '0x' + 'f'.repeat(40);
  await get('/addresses/' + missing, 503);
  const none = await sqlBaseline(db).address(369, missing);
  assert.equal(none.staking.lockedHearts, '0');
  assert.equal(none.staking.firstStakeDay, null);
  assert.equal(none.staking.nextMaturityDay, null);
  assert.deepEqual(none.staking.activity, []);
  checks.push(
    'Known indexed zero does not fabricate a live balance, first stake, maturity or activity',
  );
  const worker = await connect(databaseConfig('worker'));
  try {
    await worker.query('BEGIN');
    await worker.query('UPDATE hdd.stakes SET start_day=0,locked_day=2 WHERE stake_id=2');
    assert.equal(
      (await new SqlAddressBaseline(worker).address(369, address)).staking.firstStakeDay,
      0,
    );
    assert.equal(dayDate(0), '2019-12-03');
    await worker.query(
      "UPDATE hdd.stakes SET address=decode(repeat('ee',20),'hex') WHERE stake_id=25",
    );
    const gaOnly = (await new SqlAddressBaseline(worker).address(369, '0x' + 'ee'.repeat(20)))
      .staking;
    assert.equal(gaOnly.lockedHearts, '31250000000000');
    assert.equal(gaOnly.goodAccountedHearts, gaOnly.lockedHearts);
    assert.equal(gaOnly.accountedShares, '0');
    assert.equal(gaOnly.openCount, '0');
    assert.equal(gaOnly.nextMaturityDay, null);
    assert.equal(gaOnly.activity[0].kind, 'good_accounting');
    const endedOnly = await new SqlAddressBaseline(worker).address(
      369,
      '0x' + '2'.padStart(40, '0'),
    );
    assert.equal(endedOnly.staking.activity[0].kind, 'cancel');
    checks.push(
      'Zero-based day zero/date, GA-only locked principal without shares or maturity, cancellation activity',
    );
  } finally {
    await worker.query('ROLLBACK');
    await worker.end();
  }
  writeFileSync(
    '/evidence/address-api.json',
    JSON.stringify(
      {
        status: 'PASS',
        checks,
        measurements,
        fixture: '120 synthetic stakes; 32 for the illustrated address; not scale qualification',
        indexed: result.indexed,
      },
      null,
      2,
    ),
  );
  console.log(checks.map((c) => 'PASS ' + c).join('\n'));
} finally {
  await app.close();
  await db.close();
}
