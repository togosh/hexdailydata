import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  loadMapping,
  parseRows,
  normalize,
  add,
  ratio,
  compare,
  hash,
  validScalar,
} from '../../dist/history-bootstrap/normalize.js';
import {
  makePackage,
  publishPackage,
  validatePackage,
} from '../../dist/history-bootstrap/package.js';
const mappingBytes = await readFile(
  new URL('../../config/history-bootstrap.mapping.json', import.meta.url),
);
const mapping = loadMapping(mappingBytes);
const row = (overrides = {}) => ({
  currentDay: '3',
  date: '2019-12-06T00:00:00.000Z',
  circulatingHEX: '100.00000001',
  stakedHEX: '40',
  totalHEX: '140.00000001',
  tshareRateHEX: '10000',
  totalTshares: '2',
  currentHolders: '2',
  numberOfHolders: '50',
  stakedHEXPercent: '28.57',
  currentHoldersChange: '-1',
  priceUV2: '0.01',
  priceUV3: '0',
  ...overrides,
});
test('lossless parser retains large integers, exponents and rejects duplicate keys/nested/truncated/NaN', () => {
  const bytes = Buffer.from(
    '[{"currentDay":3,"date":"2019-12-06T00:00:00.000Z","circulatingHEX":900719925474099312345,"stakedHEX":1e-8}]',
  );
  const parsed = parseRows(bytes)[0];
  assert.equal(parsed.circulatingHEX, '900719925474099312345');
  assert.equal(parsed.stakedHEX, '1e-8');
  for (const text of ['[{"x":1,"x":1}]', '[[[[[0]]]]]', '[', '[{"x":NaN}]'])
    assert.throws(() => parseRows(Buffer.from(text)));
});
test('exact arithmetic, half-up ratio and signed minus-one are preserved', () => {
  assert.equal(add('9007199254740993.00000001', '0.00000009'), '9007199254740993.0000001');
  assert.equal(ratio('1', '8', 2), '0.13');
  assert.equal(ratio('1', '0', 18), null);
  assert.equal(compare('1e-8', '0.00000001'), 0);
  const d = normalize([row()], [], mapping).daily[0];
  assert.equal(d.currentHoldersChange, '-1');
  assert.equal(d.totalHEX, '140.00000001');
});
test('fractional counts/negative unsigned metrics rejected; zero and absent differ in originals', () => {
  const original = row({ currentHolders: '2.5', stakedHEXGA: '0', numberOfHolders: '-1' });
  const out = normalize([original], [], mapping).daily[0];
  assert.equal(out.currentHolders, null);
  assert.equal(out.holderIndexMaximum, null);
  assert.equal(out.stakedHEXGA, '0');
  assert.equal(original.currentHolders, '2.5');
});
test('holder proxy, net changes and simple annualization cannot use misleading target names', () => {
  for (const [key, name] of [
    ['numberOfHolders', 'currentHolders'],
    ['actualAPYRate', 'realizedCompoundedAPY'],
    ['dailyMintedInflationTotal', 'grossMintedHEX'],
  ]) {
    const m = structuredClone(mapping);
    m.fields.find((f) => f.input === key).target = name;
    assert.throws(() => loadMapping(Buffer.from(JSON.stringify(m))));
  }
  const m = structuredClone(mapping);
  m.fields.find((f) => f.input === 'dailyPayoutHEX').kind = 'observation';
  assert.throws(() => loadMapping(Buffer.from(JSON.stringify(m))), /UNQUALIFIED/);
});
test('skeletons do not become measured zeros and missing day0 is never fabricated', () => {
  const out = normalize([row({ currentDay: '1', date: '2019-12-04T00:00:00.000Z' })], [], mapping);
  assert.equal(out.daily.length, 1);
  assert(mapping.fields.every((f) => out.daily[0][f.target] === null));
  assert.equal(out.daily[0].day, 1);
});
test('duplicates agree independently; conflicting price does not discard supply; conflicting times reject day', () => {
  const a = row({ currentDay: '1800', date: '2024-11-05T00:00:00.000Z', pricePulseX: '0.1' }),
    b = { ...a, pricePulseX: '0.2' };
  const out = normalize([a, b], [], mapping);
  assert.equal(out.daily[0].circulatingHEX, a.circulatingHEX);
  assert.equal(out.prices[0].quoteUsd, null);
  const changed = { ...a, circulatingHEX: '101' };
  assert.equal(normalize([a, changed], [], mapping).daily[0].circulatingHEX, null);
  const dates = normalize([row(), row({ date: '2019-12-06T00:00:01.000Z' })], [], mapping);
  assert.equal(dates.daily[0].recordedAtUtc, null);
  assert(mapping.fields.every((f) => dates.daily[0][f.target] === null));
});
test('signed consecutive net changes and undefined/missing predecessors', () => {
  const out = normalize(
    [
      row(),
      row({ currentDay: '4', date: '2019-12-07T00:00:00.000Z', circulatingHEX: '99.00000001' }),
      row({ currentDay: '6', date: '2019-12-09T00:00:00.000Z' }),
    ],
    [],
    mapping,
  );
  assert.equal(out.daily[0].netTotalSupplyChangeHEX, null);
  assert.equal(out.daily[1].netTotalSupplyChangeHEX, '-1');
  assert.equal(out.daily[2].netTotalSupplyChangeHEX, null);
});
test('PulseX copied, selected-exclusion, future and zero guard; early series remain separate', () => {
  const p = row({ currentDay: '1768', date: '2024-10-04T00:02:35.000Z', pricePulseX: '0.1' });
  assert.equal(normalize([p], [], mapping).prices[0].quoteUsd, null);
  const c = { ...p, currentDay: '1800', date: '2024-11-05T00:00:00.000Z', pricePulseX: '0.01' };
  assert.equal(normalize([c], [], mapping).prices[0].quoteUsd, null);
  assert.equal(normalize([{ ...c, pricePulseX: '0' }], [], mapping).prices[0].quoteUsd, null);
  const future = {
    ...c,
    currentDay: '2505',
    date: '2026-10-11T00:00:00.000Z',
    pricePulseX: '0.03',
  };
  assert.equal(normalize([future], [], mapping).prices[0].quoteUsd, null);
  const out = normalize([], [row()], mapping);
  assert(out.prices.every((p) => p.series.startsWith('ethereum-origin-')));
  assert.equal(out.prices[0].quoteUsd, '0.01');
});

const task = process.env.HDD_TASK_ROOT;
test(
  'actual full small input/output, deterministic rerun, hashes and every CSV/scalar',
  { skip: !task },
  async () => {
    const pulse = await readFile(join(task, 'reference/parity/public-session/03.body'));
    const eth = await readFile(join(task, 'reference/parity/public-session/02.body'));
    const ledger = await readFile(join(task, 'reference/product/data/daily-ledger.json'));
    const p = makePackage(pulse, eth, ledger, mappingBytes, 'a'.repeat(64)),
      again = makePackage(pulse, eth, ledger, mappingBytes, 'a'.repeat(64));
    assert.deepEqual(p.files, again.files);
    assert.equal(hash(ledger), mapping.inputHashes.ledger);
    const raw = parseRows(pulse),
      daily = p.files['daily.ndjson'].toString().trim().split('\n').map(JSON.parse);
    assert.equal(daily.length, 2501);
    assert.equal(daily[0].day, 1);
    assert.equal(daily.at(-1).day, 2501);
    const byDay = new Map();
    for (const r of raw) {
      const d = Number(r.currentDay);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    let checked = 0;
    for (const row of daily)
      for (const f of mapping.fields) {
        const v = row[f.target];
        assert(v === null || typeof v === 'string');
        if (v !== null) {
          assert.notEqual(validScalar(v, f), null);
          if (f.kind === 'observation') assert(byDay.get(row.day).every((r) => r[f.input] === v));
          checked++;
        }
        if (f.kind === 'held' || [1, 2].includes(row.day)) assert.equal(v, null);
      }
    const prices = p.files['prices.ndjson'].toString().trim().split('\n').map(JSON.parse);
    for (const row of prices) {
      if (row.series === 'pulsechain-hex-reference-usd' && [1734, 1735, 1768].includes(row.day))
        assert.equal(row.quoteUsd, null);
      if (row.series.startsWith('ethereum-origin-'))
        assert(row.recordedAtUtc.slice(0, 10) <= '2022-12-31');
    }
    assert(daily.find((r) => r.day === 1768).circulatingHEX !== null);
    const parent = resolve('artifacts/history-bootstrap-tests');
    await mkdir(parent, { recursive: true });
    const owned = await mkdtemp(join(parent, 'run-'));
    const directory = join(owned, 'valid');
    assert.equal((await publishPackage(directory, owned, p)).changed, true);
    assert.equal((await publishPackage(directory, owned, p)).changed, false);
    const verified = await validatePackage(directory, p.manifestSha256);
    assert.equal(verified.daily.length, 2501);
    // Deliberate corruption is confined to this new fixture copy, never accepted inputs.
    const changed = Buffer.from(p.files['daily.ndjson']);
    changed[20] = changed[20] === 49 ? 50 : 49;
    await writeFile(join(directory, 'daily.ndjson'), changed);
    await assert.rejects(validatePackage(directory, p.manifestSha256), /FILE_DIGEST/);
    await assert.rejects(publishPackage(directory, owned, p), /FILE_DIGEST/);
    await writeFile(join(directory, 'daily.ndjson'), p.files['daily.ndjson'].subarray(0, 100));
    await assert.rejects(validatePackage(directory, p.manifestSha256), /FILE_DIGEST/);
    for (const b of [pulse.subarray(0, 100), Buffer.from(pulse.toString().replace('2501', '2502'))])
      assert.throws(
        () => makePackage(b, eth, ledger, mappingBytes, 'a'.repeat(64)),
        /INPUT_DIGEST/,
      );
    await assert.rejects(validatePackage(directory, 'b'.repeat(64)), /MANIFEST_DIGEST/);
    const failed = join(owned, 'failed');
    await assert.rejects(
      publishPackage(failed, owned, p, async () => {
        throw Error('SYNTHETIC_PUBLICATION_FAILURE');
      }),
      /SYNTHETIC/,
    );
    await assert.rejects(stat(failed));
    await assert.rejects(publishPackage(failed, owned, p), /OUTPUT_PUBLICATION_LOCK/);
    await assert.rejects(publishPackage(resolve(owned, '..', 'outside'), owned, p), /OUTSIDE/);
    await writeFile(
      join(task, 'evidence/HISTORY_FULL_CHECK.json'),
      JSON.stringify(
        {
          status: 'PASS',
          inputRows: raw.length,
          normalizedDays: daily.length,
          priceRows: prices.length,
          checkedNonNullScalars: checked,
          CSVParity: 'every value',
          deterministic: true,
          ledgerUnchanged: true,
          syntheticFailures: true,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
