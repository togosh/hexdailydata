import { useEffect, useState } from 'react';
import {
  ProductDailyResponseSchema,
  ProductHomeResponseSchema,
  ProductMetricSchema,
  productMetrics,
  type ProductMetric,
  type ProductRow,
} from '../contracts/product-daily.ts';
import { endpoint, request, useResource, RequestError } from './api.ts';
import { Feedback } from './components.tsx';
import { numberText } from './format.ts';
import ChartGraphic from './ChartGraphic.tsx';
import type { Point } from './history.ts';
import './product-daily.css';

const shift = (date: string, n: number) =>
  new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
export async function loadProductRange(
  from: string,
  to: string,
  metric: ProductMetric,
  signal: AbortSignal,
) {
  if (
    !Number.isFinite(Date.parse(to)) ||
    !Number.isFinite(Date.parse(from)) ||
    Date.parse(to) < Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > 10000 * 86400000
  )
    throw new RequestError(400);
  const items: ProductRow[] = [];
  let version: string | undefined;
  let metadata: ReturnType<typeof ProductDailyResponseSchema.parse> | undefined;
  for (let begin = from; begin <= to; begin = shift(begin, 366)) {
    const end = shift(begin, 365) < to ? shift(begin, 365) : to;
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (++pages > 4) throw new RequestError(503);
      const result = await request(
        endpoint('/daily', { from: begin, to: end, metric, limit: 100, cursor }),
        ProductDailyResponseSchema,
        signal,
      );
      if (version && version !== result.datasetVersion) throw new RequestError(409);
      version = result.datasetVersion;
      metadata = result;
      for (const row of result.items) {
        if (items.at(-1) && row.dateUtc <= items.at(-1)!.dateUtc) throw new RequestError(503);
        items.push(row);
      }
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
  }
  return { items, version, metadata };
}
export function productPoints(rows: readonly ProductRow[], metric: ProductMetric): Point[] {
  return rows.map((row) => ({
    key: String(row.contractDay),
    date: row.dateUtc,
    value: row[metric],
    detail: `${productMetrics[metric][1]} · ${metric === 'hexPriceUsd' ? (row.priceEra ?? 'unavailable') : productMetrics[metric][2]}`,
    status: row[metric] === null ? 'unavailable' : 'recorded',
  }));
}
export function productObservation(row: ProductRow, metric: ProductMetric) {
  if (
    (metric === 'btcPriceUsd' || metric === 'ethPriceUsd') &&
    row[metric] !== null &&
    row[metric === 'btcPriceUsd' ? 'btcRecordedAtUtc' : 'ethRecordedAtUtc'] === null
  )
    return 'Recorded-date USD reference; exact sample time unavailable, not a daily close';
  if (
    metric === 'trackedLiquidityUsd' &&
    row.trackedLiquidityUsd !== null &&
    row.liquidityRecordedAtUtc === null
  )
    return 'Source UTC-day reserve bucket; exact update time unavailable, not a verified close';
  if (metric === 'hexPriceUsd')
    return `${row.priceEra ?? 'No admitted market'} · ${row.priceRecordedAtUtc ?? 'Unavailable'}`;
  const kind = productMetrics[metric][2];
  if (kind === 'daily-total') return `Contract day ${row.contractDay}`;
  const times = {
    btcPriceUsd: row.btcRecordedAtUtc,
    ethPriceUsd: row.ethRecordedAtUtc,
    plsPriceUsd: row.plsRecordedAtUtc,
    gasPriceWei: row.gasRecordedAtUtc,
    baseFeeWei: row.gasRecordedAtUtc,
    priorityFeeWei: row.gasRecordedAtUtc,
    trackedLiquidityUsd: row.liquidityRecordedAtUtc,
  };
  if (metric in times) return times[metric as keyof typeof times] ?? 'No qualified observation';
  return row.snapshotRecordedAtUtc ?? 'No snapshot';
}
export default function History() {
  const latest = useResource(endpoint('/home'), ProductHomeResponseSchema);
  const query = new URLSearchParams(location.search);
  const selected = ProductMetricSchema.safeParse(query.get('metric'));
  const [metric, setMetric] = useState<ProductMetric>(
    selected.success ? selected.data : 'circulatingHEX',
  );
  const [from, setFrom] = useState(query.get('from') ?? ''),
    [to, setTo] = useState(query.get('to') ?? '');
  const [selection, setSelection] = useState<{
    from: string;
    to: string;
    metric: ProductMetric;
  } | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadProductRange>> | null>(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [tablePage, setTablePage] = useState(0);
  useEffect(() => {
    if (!latest.data || selection) return;
    const end = to || latest.data.dailyThroughDateUtc,
      start = from || shift(end, -90);
    setFrom(start);
    setTo(end);
    setSelection({ from: start, to: end, metric });
  }, [latest.data]);
  useEffect(() => {
    if (!selection) return;
    const c = new AbortController();
    setLoading(true);
    setError('');
    setData(null);
    setTablePage(0);
    void loadProductRange(selection.from, selection.to, selection.metric, c.signal)
      .then((d) => {
        if (!c.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e instanceof Error ? e.message : 'Data unavailable.');
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [selection]);
  const choose = (m: ProductMetric) => {
    setMetric(m);
    if (from && to) setSelection({ from, to, metric: m });
  };
  const apply = (start = from, end = to) => {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
      Date.parse(end) < Date.parse(start)
    ) {
      setError('Choose an ordered UTC date range.');
      return;
    }
    setFrom(start);
    setTo(end);
    setSelection({ from: start, to: end, metric });
  };
  const actualMetric = selection?.metric ?? metric;
  return (
    <div className="daily-product" data-testid="daily-product" data-ready={Boolean(data)}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">HEXDailyData · Daily</p>
          <h1>Daily history</h1>
          <p>
            One selected history. Exact totals, recorded snapshots and reference prices retain their
            own meanings.
          </p>
        </div>
        <a href="/live" className="button">
          Latest observations
        </a>
      </div>
      <section className="panel daily-controls">
        <label>
          Metric
          <select
            aria-label="Metric"
            value={metric}
            onChange={(e) => choose(e.target.value as ProductMetric)}
          >
            {Object.entries(productMetrics).map(([key, [label, unit]]) => (
              <option key={key} value={key}>
                {label} · {unit}
              </option>
            ))}
          </select>
        </label>
        <label>
          From (UTC)
          <input
            aria-label="From date"
            type="date"
            min="2019-12-03"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To (UTC)
          <input
            aria-label="To date"
            type="date"
            min="2019-12-03"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className="button primary" onClick={() => apply()} disabled={loading}>
          Apply dates
        </button>
        <div className="daily-presets">
          <button onClick={() => apply('2019-12-03', latest.data?.dailyThroughDateUtc ?? to)}>
            All admitted dates
          </button>
          <button onClick={() => choose('payoutPerTshareHEX')}>Daily payout rate</button>
          <button onClick={() => choose('hexPriceUsd')}>HEX price history</button>
        </div>
      </section>
      <Feedback {...latest} />
      {loading && <p role="status">Loading bounded daily pages…</p>}
      {error && (
        <p role="alert">
          {error} <button onClick={() => apply()}>Restart selection</button>
        </p>
      )}
      {data && (
        <>
          <section className="panel daily-chart">
            <div className="daily-chart-heading">
              <h2>{productMetrics[actualMetric][0]}</h2>
              <span>{productMetrics[actualMetric][1]}</span>
            </div>
            <p className="meta">
              {data.items.filter((r) => r[actualMetric] !== null).length.toLocaleString()} available
              observations · {selection?.from}–{selection?.to} UTC
            </p>
            <ChartGraphic
              points={productPoints(data.items, actualMetric)}
              title={productMetrics[actualMetric][0]}
            />
            {!data.items.some((r) => r[actualMetric] !== null) && (
              <p>No qualified values in this range. Missing values remain unavailable.</p>
            )}
            {actualMetric === 'hexPriceUsd' && (
              <p className="era-note">
                Ethereum-origin reference history and PulseChain HEX are separate labelled segments.
                The unqualified 2023 interval stays a gap. No joined returns, highs or ROI.
              </p>
            )}
            <p className="meta">
              {productMetrics[actualMetric][2] === 'daily-total'
                ? 'Ledger totals use their contract day; the payout denominator is separate from snapshot T-shares.'
                : actualMetric === 'trackedLiquidityUsd'
                  ? 'Fixed contemporary HEX-pool cohort. Source daily reserve buckets are not verified closes; missing constituent pools produce gaps.'
                  : productMetrics[actualMetric][2] === 'reference-price'
                    ? 'Historical reference quotes are not live spot prices or verified daily closes.'
                    : 'Snapshot time is the original recorded observation time, not a verified UTC daily close.'}
            </p>
          </section>
          <section className="panel">
            <h2>Daily values</h2>
            <div className="daily-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>UTC date</th>
                    <th>{productMetrics[actualMetric][0]}</th>
                    <th>Observation / period</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.slice(tablePage * 100, (tablePage + 1) * 100).map((r) => (
                    <tr key={r.dateUtc}>
                      <td>
                        {r.dateUtc}
                        <small>Day {r.contractDay}</small>
                      </td>
                      <td
                        data-exact={r[actualMetric] ?? ''}
                        title={r[actualMetric] ?? 'Unavailable'}
                      >
                        {r[actualMetric] === null ? 'Unavailable' : numberText(r[actualMetric], 8)}
                      </td>
                      <td>{productObservation(r, actualMetric)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <button disabled={tablePage === 0} onClick={() => setTablePage((n) => n - 1)}>
                Previous values
              </button>
              <span>Page {tablePage + 1}</span>
              <button
                disabled={(tablePage + 1) * 100 >= data.items.length}
                onClick={() => setTablePage((n) => n + 1)}
              >
                Next values
              </button>
            </div>
            <p>
              <a href="/downloads">Complete CSV access</a> uses these same selected values. Display
              rounding does not change API/CSV precision.
            </p>
          </section>
          <details className="panel">
            <summary>Methods, coverage and credits</summary>
            {data.metadata?.methods.map((x) => (
              <p key={x}>{x}</p>
            ))}
            <p>{data.metadata?.credits}</p>
            <p>
              Dataset <code>{data.version}</code>. Missing beginning/fork periods, current feeds and
              public redistribution qualification remain open.
            </p>
          </details>
        </>
      )}
    </div>
  );
}
export function HomeChart() {
  return (
    <p>
      <a href="/daily">Explore the selected daily history →</a>
    </p>
  );
}
