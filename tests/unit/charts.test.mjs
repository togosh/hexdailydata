import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chartDefinitions,
  seriesFor,
  archiveValue,
  maturitySeries,
  detailHref,
  chartNumber,
} from '../../src/web/charts.ts';
import { archiveChartFields, nativeChartFields, ChartsQuery } from '../../src/contracts/charts.ts';
import { plot, loadNative } from '../../src/web/history.ts';
import { decimal } from '../../src/web/format.ts';
const definition = (id) => chartDefinitions.find((d) => d.id === id);
const values = (fields, overrides = {}) =>
  fields.map((f) => (overrides[f] === undefined ? '1' : overrides[f]));
const archive = {
  items: [0, 1, 2].map((i) => ({
    day: 1255 + i,
    date: `2023-05-${11 + i}`,
    values: values(archiveChartFields),
  })),
};
const native = {
  truncated: false,
  items: archive.items.map((r) => ({
    ...r,
    originChainId: 369,
    values: values(nativeChartFields),
  })),
};
test('exactly 13 approved concepts; source support is honest in all four states', () => {
  assert.equal(chartDefinitions.length, 13);
  for (const d of chartDefinitions.filter((d) => d.id !== 'maturities')) {
    for (const [a, n] of [
      [archive, native],
      [archive, undefined],
      [undefined, native],
      [undefined, undefined],
    ]) {
      const result = seriesFor(d, a, n, 'ALL');
      assert.equal(
        result.points.some((p) => p.value !== null),
        !!((d.archive && a) || (d.native && n)),
        d.id,
      );
      if (d.native && n) assert.equal(result.source, 'native');
    }
  }
  assert.equal(ChartsQuery.safeParse({ chain: 'ethereum' }).success, false);
  assert.equal(ChartsQuery.safeParse({ metric: 'arbitrary' }).success, false);
});
test('source preference requires complete native range; gaps/pending metrics are never spliced', () => {
  const partial = { ...native, items: native.items.slice(1) };
  assert.equal(seriesFor(definition('payout'), archive, partial, 'ALL').source, 'hds');
  const pending = structuredClone(native);
  pending.items[1].values[0] = null;
  assert.equal(seriesFor(definition('payout'), archive, pending, 'ALL').source, 'hds');
  const incomplete = seriesFor(definition('payout'), undefined, pending, 'ALL');
  assert.equal(incomplete.partial, true);
  assert.equal(incomplete.points[1].value, null);
  assert.equal(seriesFor(definition('rate'), archive, pending, 'ALL').source, 'native');
});
test('current holders/stakers, native weighted years and locked percentage map their defined fields', () => {
  const a = {
    items: [
      {
        ...archive.items[0],
        values: values(archiveChartFields, {
          currentHolders: '123',
          currentStakerCount: '45',
          stakedHEXPercent: '9.1',
        }),
      },
    ],
  };
  assert.equal(seriesFor(definition('holders'), a, undefined, 'ALL').points[0].value, '123');
  assert.equal(seriesFor(definition('stakers'), a, undefined, 'ALL').points[0].value, '45');
  assert.equal(seriesFor(definition('staked'), a, undefined, 'ALL').secondary[0].value, '9.1');
  const n = {
    ...native,
    items: [{ ...native.items[0], values: values(nativeChartFields, { duration: '3650' }) }],
  };
  assert.equal(seriesFor(definition('duration'), undefined, n, 'ALL').points[0].value, '10');
});
test('T-Share USD cost preserves same-record exact exponents, extreme precision and missing inputs', () => {
  const row = {
    ...archive.items[0],
    values: values(archiveChartFields, {
      price: '1.23e-40',
      tshareRateHEX: '9007199254740993.00000001',
    }),
  };
  assert.equal(archiveValue(row, 'cost'), '0.00000000000000000000000110788550833314213900000123');
  row.values[0] = null;
  assert.equal(archiveValue(row, 'cost'), null);
  row.values[0] = '1e-999';
  row.values[2] = '1e-999';
  const exact = archiveValue(row, 'cost');
  assert.equal(exact, '0.' + '0'.repeat(1997) + '1');
  assert.equal(decimal(exact), exact);
  assert.equal(chartNumber(exact), '1.00 × 10^-1998');
  assert.ok(
    Number.isFinite(
      plot([{ key: '1', date: '2024-01-01', value: exact, status: '', detail: '' }]).coordinates[0]
        .y,
    ),
  );
});
test('missing price / missing date breaks plot and derived cost; drill-down preserves selection', () => {
  const a = structuredClone(archive);
  a.items[1].values[0] = null;
  const s = seriesFor(definition('price'), a, undefined, 'ALL');
  assert.equal(plot(s.points).lines.length, 0);
  assert.equal(seriesFor(definition('cost'), a, undefined, 'ALL').points[1].value, null);
  a.items.splice(1, 1);
  assert.equal(plot(seriesFor(definition('price'), a, undefined, 'ALL').points).lines.length, 0);
  assert.match(
    detailHref(definition('price'), s),
    /source=hds&metric=price&from=2023-05-11&to=2023-05-13/,
  );
});
test('maturity bins retain exact amounts, zero versus later range, and all unit totals', () => {
  const m = {
    cutoff: { contractDay: 2000 },
    items: [
      {
        day: 2001,
        principalHearts: '900719925474099300000001',
        stakeShares: '2000000000000',
        count: '2',
      },
      { day: 2500, principalHearts: '100000001', stakeShares: '500000000000', count: '1' },
    ],
  };
  assert.equal(maturitySeries(m, 90, 'HEX').total, '9007199254740993.00000001');
  assert.equal(maturitySeries(m, 0, 'Stake Count').total, '3');
  assert.equal(maturitySeries(m, 0, 'T-Shares').total, '2.5');
  assert.ok(maturitySeries(m, 0, 'HEX').points.length <= 60);
  const later = { ...m, items: m.items.slice(1) };
  assert.equal(maturitySeries(later, 90, 'HEX').total, '0');
  assert.equal(maturitySeries(later, 90, 'HEX').beyond, true);
  assert.equal(maturitySeries({ ...m, items: [] }, 0, 'HEX').beyond, false);
});
test('native exact windows retain one cutoff and reject index movement instead of joining revisions', async () => {
  let calls = 0;
  const get = async (url) => {
    const q = new URL(url, 'http://localhost').searchParams;
    const fromDay = Math.floor((Date.parse(q.get('from')) - Date.parse('2019-12-03')) / 86400000);
    const toDay = Math.floor((Date.parse(q.get('to')) - Date.parse('2019-12-03')) / 86400000);
    calls++;
    return {
      chain: 'pulsechain',
      cutoff: { revision: '1' },
      items: [],
      coverage: { fromDay, toDay, expected: toDay - fromDay + 1, count: 0, missingDays: [] },
    };
  };
  const result = await loadNative('2024-01-01', '2025-02-03', new AbortController().signal, get);
  assert.equal(calls, 2);
  assert.equal(result.coverage.expected, 400);
  calls = 0;
  await assert.rejects(
    loadNative('2024-01-01', '2025-02-03', new AbortController().signal, async (url) => {
      const r = await get(url);
      r.cutoff.revision = String(calls);
      return r;
    }),
    /changed or expired/,
  );
});
