import { useEffect, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { DailyResponseSchema } from '../contracts/reads.ts';
import { metricDefinitions, type Metric as ArchiveMetric } from '../contracts/history.ts';
import { displayRatio, hexPerTShareBeforeBonuses } from '../domain/units.ts';
import { endpoint, request, RequestError, useResource } from './api.ts';
import { dateShift, today, numberText } from './format.ts';
import { Feedback, Table } from './components.tsx';
import { Icon } from './visuals.tsx';
import { loadArchive, validRange, plot, type Point } from './history.ts';

type Daily = z.infer<typeof DailyResponseSchema>;
const nativeMetrics = {
  payout: ['Completed payout', 'HEX/T-share'],
  rate: ['Share rate before bonuses', 'HEX/T-share'],
  duration: ['Weighted original duration', 'days'],
  percent: ['Percentage staked', '%'],
  circulating: ['Circulating supply', 'HEX'],
  locked: ['Locked principal (includes GA)', 'HEX'],
  holders: ['Current holders', 'addresses'],
  stakers: ['Current stakers', 'addresses'],
} as const;
type NativeMetric = keyof typeof nativeMetrics;
function nativePoints(data: Daily, metric: NativeMetric): Point[] {
  return data.items.map((r) => ({
    key: String(r.contractDay),
    date: r.dateUtc,
    value:
      metric === 'payout'
        ? r.payout.hexPerTShare
        : metric === 'rate'
          ? displayRatio(hexPerTShareBeforeBonuses(BigInt(r.rawShareRate)))
          : metric === 'duration'
            ? r.weightedStakeLengthDays
            : metric === 'percent'
              ? r.stakedPercent
              : metric === 'circulating'
                ? r.circulatingHex
                : metric === 'locked'
                  ? r.stakedHex
                  : metric === 'holders'
                    ? r.holderCount
                    : r.stakerCount,
    detail: `Contract day ${r.contractDay} / display ${r.displayDay} · ${r.originChainId === 1 ? 'inherited Ethereum origin' : 'PulseChain origin'} · block ${r.asOf.blockNumber}`,
    status: metric === 'payout' ? r.payout.status : 'native daily',
  }));
}
export function Chart({
  points,
  title,
  unit,
  compact = false,
  controls,
}: {
  points: Point[];
  title: string;
  unit: string;
  compact?: boolean;
  controls?: ReactNode;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [points]);
  const graph = plot(points);
  return (
    <div data-testid="history-chart" data-ready={points.some((p) => p.value !== null)}>
      <div className="section-heading">
        <h2>
          {compact && <Icon name="chart" />}
          {title}
        </h2>
        {controls ?? <span className="meta">{unit}</span>}
      </div>
      {compact && <span className="meta">{unit}</span>}
      {points.length ? (
        <>
          <svg
            className="chart"
            viewBox="0 0 800 270"
            role="img"
            aria-label={`${title}, ${unit}. ${compact ? 'Exact daily values available on the Charts page.' : 'Exact values and gaps in the data table below.'}`}
          >
            {[35, 127, 220].map((y) => (
              <line key={y} x1="70" x2="770" y1={y} y2={y} className="gridline" />
            ))}
            <text x="65" y="30" textAnchor="end">
              {graph.maxLabel}
            </text>
            <text x="65" y="225" textAnchor="end">
              {graph.minLabel}
            </text>
            <path d={graph.lines.join(' ')} className="series" />
            {graph.coordinates
              .filter((p) => p.y !== null)
              .map((p) => (
                <circle key={p.key} cx={p.x} cy={p.y!} r="2.5">
                  <title>
                    {p.date} · {p.value} {unit} · {p.detail}
                  </title>
                </circle>
              ))}
            <text x="70" y="255">
              {points[0]?.date}
            </text>
            <text x="770" y="255" textAnchor="end">
              {points.at(-1)?.date}
            </text>
          </svg>
          {!compact && (
            <p className="meta">
              Missing dates and unavailable values break the line. Same-date records remain separate
              markers and rows.
            </p>
          )}
        </>
      ) : (
        <p className="notice">No records in this range. Select an available interval below.</p>
      )}
      {!compact && (
        <details open>
          <summary>Data table · {points.length} records</summary>
          <Table
            title={`${title} — exact published values`}
            headings={['Date (UTC)', unit, 'State', 'Source detail']}
          >
            {points.slice(page * 100, (page + 1) * 100).map((p) => (
              <tr key={p.key}>
                <td>{p.date}</td>
                <td className="exact">{p.value === null ? 'Unavailable' : numberText(p.value)}</td>
                <td>{p.status}</td>
                <td>{p.detail}</td>
              </tr>
            ))}
          </Table>
          {points.length > 100 && (
            <div className="pager">
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                Previous rows
              </button>
              <span>
                {page * 100 + 1}–{Math.min(points.length, (page + 1) * 100)} of {points.length}
              </span>
              <button
                disabled={(page + 1) * 100 >= points.length}
                onClick={() => setPage(page + 1)}
              >
                Next rows
              </button>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
export function HomeChart({ date }: { date: string | null }) {
  const [days, setDays] = useState(30);
  const data = useResource(
    date
      ? endpoint('/daily', {
          from: dateShift(date, 1 - days) < '2019-12-03' ? '2019-12-03' : dateShift(date, 1 - days),
          to: date,
        })
      : null,
    DailyResponseSchema,
  );
  const controls = (
    <div className="range-buttons" aria-label="Payout history range">
      {[7, 30].map((n) => (
        <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>
          {n}D
        </button>
      ))}
    </div>
  );
  return (
    <section className="panel home-chart">
      {data.data ? (
        <Chart
          points={nativePoints(data.data, 'payout')}
          title="Payout per T-share"
          unit="HEX/T-share"
          compact
          controls={controls}
        />
      ) : (
        <p>
          {data.loading
            ? 'Loading payout history…'
            : 'Native payout history unavailable. Reported HDS history is separate in Charts.'}
        </p>
      )}
      {data.error && <Feedback {...data} />}
    </section>
  );
}
type Selection = {
  source: 'hds' | 'native';
  from: string;
  to: string;
  metric: string;
  all: boolean;
};
function initial(): Selection {
  const defaults: Selection = {
    source: 'hds',
    from: dateShift(today(), -29),
    to: today(),
    metric: 'price',
    all: false,
  };
  try {
    const stored = JSON.parse(sessionStorage.getItem('history-selection') ?? 'null');
    if (
      stored &&
      ['hds', 'native'].includes(stored.source) &&
      validRange(stored.from, stored.to) &&
      typeof stored.metric === 'string'
    )
      return { ...stored, all: false };
  } catch {
    /* Storage may be disabled. */
  }
  return defaults;
}
export default function History() {
  const [selection, setSelection] = useState<Selection>(initial),
    [from, setFrom] = useState(selection.from),
    [to, setTo] = useState(selection.to);
  const [version, setVersion] = useState(0),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [archive, setArchive] = useState<Awaited<ReturnType<typeof loadArchive>>>(),
    [native, setNative] = useState<Daily>();
  const select = (s: Selection) => {
    setArchive(undefined);
    setNative(undefined);
    setError('');
    setLoading(true);
    setSelection(s);
    setFrom(s.from);
    setTo(s.to);
  };
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    setArchive(undefined);
    setNative(undefined);
    void (async () => {
      try {
        if (selection.source === 'hds') {
          const result = await loadArchive(selection.from, selection.to, controller.signal);
          if (active) setArchive(result);
        } else {
          const result = await request(
            endpoint('/daily', { from: selection.from, to: selection.to }),
            DailyResponseSchema,
            controller.signal,
          );
          if (active) setNative(result);
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof RequestError
              ? e.message
              : 'History could not be completed safely. Restart the selection.',
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [selection.source, selection.from, selection.to, selection.all, version]);
  useEffect(() => {
    if (!selection.all) {
      try {
        sessionStorage.setItem('history-selection', JSON.stringify(selection));
      } catch {}
    }
  }, [selection]);
  const hds = selection.source === 'hds';
  const metric = hds
    ? selection.metric === 'price' || selection.metric in metricDefinitions
      ? selection.metric
      : 'price'
    : selection.metric in nativeMetrics
      ? selection.metric
      : 'payout';
  const unit = hds
    ? metric === 'price'
      ? 'USD/HEX'
      : metricDefinitions[metric as ArchiveMetric].unit
    : nativeMetrics[metric as NativeMetric][1];
  const title = hds
    ? metric === 'price'
      ? 'HDS reference price'
      : metricDefinitions[metric as ArchiveMetric].meaning
    : nativeMetrics[metric as NativeMetric][0];
  const points: Point[] = hds
    ? (archive?.rows ?? []).map((r) => {
        const v = metric === 'price' ? r.referencePriceUsd : r.metrics[metric as ArchiveMetric];
        return {
          key: String(r.sourceDay),
          date: r.sourceRecordDateUtc,
          value: v.value,
          status: v.availability,
          detail: `HDS sourceDay ${r.sourceDay} · ${r.sourceDate} · ${r.dateRelationship}${v.published !== null && v.value === null ? ' · excluded published token ' + v.published : ''}`,
        };
      })
    : native
      ? nativePoints(native, metric as NativeMetric)
      : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Explore the record</p>
          <h1>Charts &amp; daily history</h1>
        </div>
      </div>
      <div className="panel controls">
        <label>
          Source
          <select
            aria-label="Source"
            value={selection.source}
            onChange={(e) =>
              select({
                ...selection,
                source: e.target.value as Selection['source'],
                metric: e.target.value === 'hds' ? 'price' : 'payout',
                all: false,
                from: dateShift(today(), -29),
                to: today(),
              })
            }
          >
            <option value="hds">HDS reported history</option>
            <option value="native">Native daily history</option>
          </select>
        </label>
        <label>
          Metric
          <select
            aria-label="Metric"
            value={metric}
            onChange={(e) => setSelection({ ...selection, metric: e.target.value })}
          >
            {hds ? (
              <>
                <option value="price">HDS reference price</option>
                {Object.entries(metricDefinitions).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.meaning} ({v.unit})
                  </option>
                ))}
              </>
            ) : (
              Object.entries(nativeMetrics).map(([k, v]) => (
                <option key={k} value={k}>
                  {v[0]} ({v[1]})
                </option>
              ))
            )}
          </select>
        </label>
        <form
          className="date-controls"
          onSubmit={(e) => {
            e.preventDefault();
            if (!validRange(from, to)) {
              setError('Choose an ordered interval of at most 366 dates.');
              return;
            }
            select({ ...selection, from, to, all: false });
            setVersion((v) => v + 1);
          }}
        >
          <label>
            From (UTC)
            <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To (UTC)
            <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button className="primary">Apply range</button>
        </form>
      </div>
      <p className="notice">
        {hds
          ? 'Source: HEXDailyStats · PulseChain reported statistics. Dates are source-record dates; market close times are unproved. Reference prices are neither OHLC nor executable prices. Common Ethereum-era native history is a separate source.'
          : 'Native protocol daily values. Pending payouts remain unavailable until materialized. Inherited Ethereum origins remain identified.'}
      </p>
      <Feedback loading={loading} error={error} refresh={() => setVersion((v) => v + 1)} />
      {!loading && !error && (
        <section className="panel">
          <p className="meta">
            Complete selection: {selection.from}–{selection.to} · {points.length} records
            {archive
              ? ` · ${archive.pages} page(s) · one archive revision`
              : native
                ? ` · ${native.coverage.missingDays.length} missing days`
                : ''}
          </p>
          <Chart points={points} title={title} unit={unit} />
        </section>
      )}
      {archive && (
        <section className="panel">
          <h2>Available HDS interval</h2>
          <p>
            {archive.first.metadata.summary.firstRecordDateUtc}–
            {archive.first.metadata.summary.lastRecordDateUtc} ·{' '}
            {archive.first.metadata.summary.records} records ·{' '}
            {archive.first.metadata.summary.prices} admitted reference prices.
          </p>
          <p className="meta">
            Acquired {archive.first.metadata.selection.provenance.acquiredAt}. No automatic
            full-archive download.
          </p>
          <button
            onClick={() =>
              select({
                ...selection,
                from: archive.first.metadata.summary.firstRecordDateUtc,
                to: archive.first.metadata.summary.lastRecordDateUtc,
                all: true,
              })
            }
          >
            Load all available HDS records
          </button>
        </section>
      )}
    </>
  );
}
