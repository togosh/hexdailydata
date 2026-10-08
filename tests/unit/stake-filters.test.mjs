import test from 'node:test';
import assert from 'node:assert/strict';
import { StakesQuery } from '../../src/contracts/reads.ts';
import { stakesSql, stakeColumns } from '../../src/services/queries/lists.ts';

const q = { lifecycle: 'open', maturityFromDay: '2001', maturityToDay: '2007' };
test('stake maturity filters normalize bounded days and preserve the legacy default object', () => {
  assert.deepEqual(StakesQuery.parse({}), { chain: 'pulsechain', limit: 50 });
  assert.equal(StakesQuery.parse({ chain: 'ethereum', lifecycle: 'ended' }).chain, 'ethereum');
  const parsed = StakesQuery.parse({
    ...q,
    maturityFromDay: '02001',
    minPrincipalHearts: '9007199254740993',
  });
  assert.equal(parsed.maturityFromDay, 2001);
  assert.equal(parsed.minPrincipalHearts, '9007199254740993');
  for (const [from, to] of [
    ['0', '0'],
    ['0', '365'],
    ['65535', '65535'],
  ]) {
    assert.ok(StakesQuery.safeParse({ ...q, maturityFromDay: from, maturityToDay: to }).success);
  }
  assert.ok(
    StakesQuery.safeParse({ ...q, minPrincipalHearts: ((1n << 256n) - 1n).toString() }).success,
  );
});
test('stake filter combinations reject blank, duplicate, fractional and inexact quantities', () => {
  for (const input of [
    { maturityFromDay: '2001', maturityToDay: '2007' },
    { ...q, chain: 'ethereum' },
    { ...q, lifecycle: 'ended' },
    { ...q, maturityToDay: undefined },
    { lifecycle: 'open', minPrincipalHearts: '0' },
    { ...q, maturityFromDay: '2008' },
    { ...q, maturityFromDay: '0', maturityToDay: '366' },
    ...['', ' ', '1.5', '1e3', '-1', '65536', ['2001', '2001']].map((value) => ({
      ...q,
      maturityFromDay: value,
    })),
    ...[
      '',
      '01',
      '+1',
      '-1',
      '1.0',
      '1e3',
      '9'.repeat(79),
      (1n << 256n).toString(),
      ['0', '0'],
    ].map((value) => ({ ...q, minPrincipalHearts: value })),
  ])
    assert.equal(StakesQuery.safeParse(input).success, false, JSON.stringify(input));
});
test('stake SQL preserves old callers and filters before pagination and event joins', () => {
  assert.equal(
    stakesSql(false),
    `WITH selected AS MATERIALIZED (SELECT * FROM hdd.stakes WHERE chain_id=$1 AND stake_id>$2   ORDER BY stake_id LIMIT $3) ${stakeColumns}`,
  );
  assert.equal(
    stakesSql(true),
    `WITH selected AS MATERIALIZED (SELECT * FROM hdd.stakes WHERE chain_id=$1 AND stake_id>$2 AND address=$4  ORDER BY stake_id LIMIT $3) ${stakeColumns}`,
  );
  for (const address of [false, true]) {
    const sql = stakesSql(address, 'open', true),
      first = address ? 5 : 4;
    const predicate = `locked_day+staked_days BETWEEN $${first}::int AND $${first + 1}::int AND principal_hearts>=$${first + 2}::numeric`;
    assert.ok(sql.includes(predicate));
    assert.ok(sql.indexOf(predicate) < sql.indexOf('LIMIT $3'));
    assert.match(sql, /lifecycle='unsettled'/);
    assert.ok(sql.indexOf('LIMIT $3') < sql.indexOf('LEFT JOIN hdd.events'));
  }
});
