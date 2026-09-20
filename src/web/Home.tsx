import { lazy, Suspense, useEffect, useState } from 'react';
import { HomeResponseSchema } from '../contracts/api.ts';
import { useResource, endpoint, useClock } from './api.ts';
import { Metric, Table, Copy } from './components.tsx';
import {
  compactNumber,
  compactObservation,
  observationState,
  dayLabel,
  yearsFromDays,
} from './format.ts';
import { Dialog, Icon, type IconName } from './visuals.tsx';

const HomeChart = lazy(() => import('./History.tsx').then((m) => ({ default: m.HomeChart })));
export default function Home() {
  const home = useResource(endpoint('/home'), HomeResponseSchema, true);
  const now = useClock(),
    h = home.data;
  const [chart, setChart] = useState(false),
    [details, setDetails] = useState(false);
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
  const dailyNote = h?.daily ? h.daily.dateUtc + ' · native daily' : 'Native daily unavailable';
  const ready = !!(
    h?.daily?.stakedPercent != null &&
    h.daily.weightedStakeLengthDays != null &&
    ps !== 'unavailable' &&
    cs !== 'unavailable'
  );
  const facts = [
    ['Locked principal (incl. GA)', h?.daily?.stakedHex, 'HEX'],
    ['Circulating supply', h?.daily?.circulatingHex, 'HEX'],
    ['Holders', h?.daily?.holderCount, ''],
    ['Stakers', h?.daily?.stakerCount, ''],
  ] as const;
  return (
    <div className="home-page">
      <h1 className="sr-only">Your daily view</h1>
      <div className="home-context">
        <span className="chain-context">
          <Icon name="link" />
          PulseChain
        </span>
        <span className="context-note">Independent source ages</span>
        <div className="home-actions">
          <button onClick={() => setDetails(true)} aria-haspopup="dialog">
            Details
          </button>
          <button onClick={home.refresh} disabled={home.loading}>
            Refresh
          </button>
        </div>
      </div>
      <dl className="home-metrics" data-testid="headlines" data-ready={ready}>
        <Metric
          id="price"
          icon="price"
          title="HEX price"
          value={ps === 'unavailable' ? null : price?.value?.usdPerHex}
          prefix="$"
          display={compactNumber(price?.value?.usdPerHex, 7)}
          note={
            <>
              <span>{compactObservation(price, now, ps)}</span>
              <span>
                Provisional
                {price?.value
                  ? price.value.valuation === 'peg_assumed'
                    ? ' · USD peg assumed'
                    : ' · USD anchor'
                  : ''}
              </span>
            </>
          }
        />
        <Metric
          id="completed"
          icon="chart"
          title="Completed payout"
          value={cs === 'unavailable' ? null : completed?.value?.hexPerTShare}
          unit="HEX/T-share"
          display={compactNumber(completed?.value?.hexPerTShare, 3)}
          note={
            <>
              <span>
                {completed?.value ? dayLabel(completed.value.contractDay) : 'No materialized day'}
              </span>
              <span>{compactObservation(completed, now, cs)}</span>
            </>
          }
        />
        <Metric
          id="staked"
          icon="pie"
          title="Percentage staked"
          value={h?.daily?.stakedPercent}
          unit="%"
          display={compactNumber(h?.daily?.stakedPercent, 2, false)}
          note={dailyNote}
        />
        <Metric
          id="duration"
          icon="clock"
          title="Weighted stake length"
          value={h?.daily?.weightedStakeLengthDays}
          unit="years"
          display={compactNumber(yearsFromDays(h?.daily?.weightedStakeLengthDays), 2, false)}
          note={
            <>
              <span>Original duration · HEX-weighted</span>
              <span>{dailyNote}</span>
            </>
          }
        />
        <Metric
          id="rate"
          icon="database"
          title="T-share rate"
          value={rs === 'unavailable' ? null : rate?.value?.hexPerTShareBeforeBonuses}
          unit="HEX/T-share"
          display={compactNumber(rate?.value?.hexPerTShareBeforeBonuses, 1, false)}
          note={
            <>
              <span>{compactObservation(rate, now, rs)}</span>
              <span>Provisional · before bonuses</span>
            </>
          }
        />
        <Metric
          id="estimate"
          icon="calendar"
          title="Today’s payout estimate"
          value={es === 'unavailable' ? null : estimate?.value?.hexPerTShare}
          unit="HEX/T-share"
          display={compactNumber(estimate?.value?.hexPerTShare, 3)}
          note={
            <>
              <span>
                {es !== 'unavailable' && estimate?.value
                  ? dayLabel(estimate.value.contractDay)
                  : 'No current-day estimate'}
              </span>
              <span>{compactObservation(estimate, now, es)} · not final</span>
            </>
          }
        />
      </dl>
      {(home.loading || home.error) && (
        <p className="home-feedback" role="status">
          {home.error
            ? home.error + (h ? ' Last received data retains its source age.' : '')
            : 'Loading current observations…'}
        </p>
      )}
      {!h && !home.loading && (
        <p className="notice">
          Current native data is unavailable. Explore the separately attributed{' '}
          <a href="/charts">HDS archive in Charts</a>.
        </p>
      )}
      <div className="home-dashboard">
        <section className="panel home-facts">
          <div className="home-panel-heading">
            <h2>
              <Icon name="database" />
              Supply &amp; staking
            </h2>
          </div>
          <p className="panel-context">{dailyNote}</p>
          <dl className="fact-rows">
            {facts.map(([label, value, unit]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {compactNumber(value, unit ? 2 : 0, !!unit)}
                  {value != null && unit && <small> {unit}</small>}
                </dd>
              </div>
            ))}
          </dl>
          <p className="panel-context">
            Native daily snapshot · <a href="/learn">Methodology</a>
          </p>
        </section>
        <div className="home-chart-slot">
          {chart && (
            <Suspense fallback={<p>Loading chart controls…</p>}>
              <HomeChart date={h?.daily?.dateUtc ?? null} />
            </Suspense>
          )}
        </div>
      </div>
      <nav className="home-shortcuts" aria-label="Quick actions">
        {(
          [
            ['/downloads', 'Downloads', 'Five standard CSVs', 'download'],
            ['/search', 'Address lookup', 'Balances & stakes', 'search'],
            ['/calculator', 'Calculator', 'Shares & scenarios', 'calendar'],
            ['/charts', 'Charts', 'Native & reported history', 'chart'],
          ] satisfies [string, string, string, IconName][]
        ).map(([href, title, note, icon]) => (
          <a href={href} key={href}>
            <Icon name={icon} />
            <span>
              <strong>{title}</strong>
              <small>{note}</small>
            </span>
          </a>
        ))}
      </nav>
      <p className="home-footnote">
        Provisional observations age independently. ≈ indicates truncated display precision.{' '}
        <button className="text-action" onClick={() => setDetails(true)} aria-haspopup="dialog">
          Exact values &amp; methodology
        </button>
      </p>
      {details && (
        <Dialog title="Home details & methodology" onClose={() => setDetails(false)}>
          <p>
            PulseChain HEX. Current observations are provisional; completed payout identifies the
            latest materialized day and may lag yesterday. Today’s estimate excludes unknown future
            changes and penalties. It is not final.
          </p>
          <p>
            Daily values use their own dated native snapshot. Locked principal includes
            good-accounted (GA) stakes. Percentage includes all locked principal; weighted original
            duration uses accounted principal. Display years use 365.25 days. Values are truncated
            for display; the exact received strings below remain selectable and copyable, including
            after expiry.
          </p>
          <p>
            <a href="/learn">Full methodology</a> · <a href="/status">Independent data status</a>
          </p>
          {h ? (
            <>
              <Table
                title="Current observation detail"
                headings={['Metric / eligibility', 'Exact received value', 'Source / method']}
              >
                {Object.entries(h.live).map(([key, row]) => {
                  const exact =
                    row.value === null
                      ? null
                      : 'usdPerHex' in row.value
                        ? row.value.usdPerHex + ' USD/HEX'
                        : 'rawShareRate' in row.value
                          ? row.value.rawShareRate +
                            ' raw / ' +
                            row.value.hexPerTShareBeforeBonuses +
                            ' HEX/T-share'
                          : row.value.hexPerTShare +
                            ' HEX/T-share · ' +
                            dayLabel(row.value.contractDay);
                  return (
                    <tr key={key}>
                      <td>
                        {key}
                        <small className="block">
                          {observationState(
                            row,
                            now,
                            key === 'todayPayoutEstimate'
                              ? estimate?.value?.contractDay
                              : undefined,
                          )}{' '}
                          · {row.finality}
                        </small>
                      </td>
                      <td className="exact">
                        {exact ?? 'Unavailable'}
                        {exact && <Copy text={exact} label={'Copy ' + key} />}
                      </td>
                      <td className="exact">
                        {row.asOf
                          ? 'Chain ' +
                            row.asOf.chainId +
                            ' · block ' +
                            row.asOf.blockNumber +
                            ' · ' +
                            row.asOf.blockTimestamp
                          : 'No source block'}
                        <small className="block">
                          Collected: {row.observedAt ?? 'Unavailable'}
                        </small>
                        <small className="block">
                          {row.method} · {row.notes.join(' · ')}
                        </small>
                        {row.value && 'valuation' in row.value && (
                          <small className="block">{row.value.valuation}</small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Table>
              {h.daily && (
                <>
                  <p className="meta">
                    Native daily {dayLabel(h.daily.contractDay)} · chain {h.daily.asOf.chainId} ·
                    block {h.daily.asOf.blockNumber} ·{' '}
                    {h.daily.asOf.blockTimestamp ?? 'Block time unavailable'}
                  </p>
                  <Table
                    title="Exact native daily values"
                    headings={['Metric', 'Exact received value']}
                  >
                    {[
                      ...facts,
                      ['Percentage staked', h.daily.stakedPercent, '%'],
                      ['Weighted original duration', h.daily.weightedStakeLengthDays, 'days'],
                    ].map(([label, value, unit]) => (
                      <tr key={label}>
                        <td>{label}</td>
                        <td className="exact">
                          {value ?? 'Unavailable'} {value != null ? unit : ''}
                          {value != null && <Copy text={value} label={'Copy ' + label} />}
                        </td>
                      </tr>
                    ))}
                  </Table>
                </>
              )}
            </>
          ) : (
            <p>
              Native observations are unavailable. Reported HDS history remains separate in Charts.
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
