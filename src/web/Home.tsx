import { lazy, Suspense, useEffect, useState } from 'react';
import { HomeResponseSchema } from '../contracts/api.ts';
import { useResource, endpoint, useClock } from './api.ts';
import { Metric, Feedback, SearchForm, Value, Table } from './components.tsx';
import { observationLabel, observationState, dayLabel } from './format.ts';

const HomeChart = lazy(() => import('./History.tsx').then((m) => ({ default: m.HomeChart })));
export default function Home() {
  const home = useResource(endpoint('/home'), HomeResponseSchema, true);
  const now = useClock(),
    h = home.data;
  const [chart, setChart] = useState(false);
  useEffect(() => {
    if (!home.loading) {
      const t = setTimeout(() => setChart(true), 0);
      return () => clearTimeout(t);
    }
  }, [home.loading]);
  const price = h?.live.price,
    rate = h?.live.shareRate,
    completed = h?.live.latestCompletedPayout,
    estimate = h?.live.todayPayoutEstimate;
  const ps = observationState(price, now),
    rs = observationState(rate, now),
    cs = observationState(completed, now),
    es = observationState(estimate, now, estimate?.value?.contractDay);
  const dailyNote = h?.daily
    ? h.daily.dateUtc + ' · native daily'
    : 'Native daily data unavailable';
  const ready = !!(
    h?.daily?.stakedPercent != null &&
    h.daily.weightedStakeLengthDays != null &&
    ps !== 'unavailable' &&
    cs !== 'unavailable'
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PulseChain · HEX</p>
          <h1>Your daily view</h1>
        </div>
        <SearchForm compact />
      </div>
      <dl className="headline-grid" data-testid="headlines" data-ready={ready}>
        <Metric
          id="price"
          title="HEX price"
          value={ps === 'unavailable' ? null : price?.value?.usdPerHex}
          prefix="$"
          note={
            <>
              {observationLabel(price, now, ps)}
              {price?.value && (
                <span>
                  {' '}
                  ·{' '}
                  {price.value.valuation === 'peg_assumed'
                    ? 'USD peg assumed'
                    : 'independent USD anchor'}
                </span>
              )}
            </>
          }
        />
        <Metric
          id="staked"
          title="Percentage staked"
          value={h?.daily?.stakedPercent}
          unit="%"
          note={dailyNote}
        />
        <Metric
          id="duration"
          title="Weighted stake length"
          value={h?.daily?.weightedStakeLengthDays}
          unit="days"
          note={<>Original duration · {dailyNote}</>}
        />
        <Metric
          id="completed"
          title="Completed payout"
          value={cs === 'unavailable' ? null : completed?.value?.hexPerTShare}
          unit="HEX/T-share"
          note={
            <>
              {completed?.value ? dayLabel(completed.value.contractDay) : 'No materialized day'}
              <br />
              {observationLabel(completed, now, cs)}
            </>
          }
        />
      </dl>
      <dl className="secondary-grid">
        <Metric
          id="rate"
          title="T-share rate"
          value={rs === 'unavailable' ? null : rate?.value?.hexPerTShareBeforeBonuses}
          unit="HEX/T-share"
          note={<>Before new-stake bonuses · {observationLabel(rate, now, rs)}</>}
        />
        <Metric
          id="estimate"
          title="Today’s payout estimate"
          value={es === 'unavailable' ? null : estimate?.value?.hexPerTShare}
          unit="HEX/T-share"
          note={
            <>
              Provisional, not final ·{' '}
              {es !== 'unavailable' && estimate?.value
                ? dayLabel(estimate.value.contractDay)
                : 'No current-day estimate'}
              <br />
              {observationLabel(estimate, now, es)}
            </>
          }
        />
      </dl>
      <Feedback {...home} hasData={!!h} />
      {!h && !home.loading && (
        <p className="notice">
          Current native data is unavailable. Explore the separately attributed{' '}
          <a href="/charts">HDS archive in Charts</a>.
        </p>
      )}
      <section className="panel">
        <div className="section-heading">
          <h2>Supply &amp; staking</h2>
          <span className="meta">{dailyNote}</span>
        </div>
        <dl className="summary-grid">
          <div>
            <dt>Circulating supply</dt>
            <dd>
              <Value value={h?.daily?.circulatingHex} unit="HEX" places={2} />
            </dd>
          </div>
          <div>
            <dt>Locked principal</dt>
            <dd>
              <Value value={h?.daily?.stakedHex} unit="HEX" places={2} />
            </dd>
          </div>
          <div>
            <dt>Current holders</dt>
            <dd>
              <Value value={h?.daily?.holderCount} />
            </dd>
          </div>
          <div>
            <dt>Current stakers</dt>
            <dd>
              <Value value={h?.daily?.stakerCount} />
            </dd>
          </div>
        </dl>
      </section>
      <div className="quick-links">
        <a href="/calculator">
          <strong>Stake calculator ↗</strong>
          <span>Shares, timing &amp; scenarios</span>
        </a>
        <a href="/downloads">
          <strong>Download data ↓</strong>
          <span>Five standard CSV files</span>
        </a>
        <a href="/charts">
          <strong>Explore charts ↗</strong>
          <span>Native &amp; reported history</span>
        </a>
      </div>
      {chart && (
        <Suspense fallback={<p>Loading chart controls…</p>}>
          <HomeChart date={h?.daily?.dateUtc ?? null} />
        </Suspense>
      )}
      {h && (
        <details className="panel">
          <summary>Exact received values &amp; observation details</summary>
          <Table
            title="Current observation detail"
            headings={['Metric', 'Exact value', 'Source block / time', 'Collected']}
          >
            {Object.entries(h.live).map(([key, row]) => (
              <tr key={key}>
                <td>{key}</td>
                <td className="exact">
                  {row.value === null
                    ? 'Unavailable'
                    : 'usdPerHex' in row.value
                      ? row.value.usdPerHex + ' USD/HEX'
                      : 'rawShareRate' in row.value
                        ? row.value.rawShareRate +
                          ' raw / ' +
                          row.value.hexPerTShareBeforeBonuses +
                          ' HEX/T-share'
                        : row.value.hexPerTShare +
                          ' HEX/T-share · ' +
                          dayLabel(row.value.contractDay)}
                  <small className="block">
                    Received {row.status}; current eligibility is shown above.
                  </small>
                </td>
                <td>
                  {row.asOf
                    ? `${row.asOf.blockNumber} · ${row.asOf.blockTimestamp}`
                    : 'Unavailable'}
                </td>
                <td>{row.observedAt ?? 'Unavailable'}</td>
              </tr>
            ))}
          </Table>
          {h.daily && (
            <p className="meta">
              Native daily {h.daily.dateUtc}: {h.daily.stakedPercent ?? 'unavailable'}% staked;{' '}
              {h.daily.weightedStakeLengthDays ?? 'unavailable'} principal-weighted original days.
              Source chain {h.daily.asOf.chainId}, block {h.daily.asOf.blockNumber}.
            </p>
          )}
        </details>
      )}
    </>
  );
}
