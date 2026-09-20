import { lazy, Suspense, useEffect, useState } from 'react';
import { HomeResponseSchema } from '../contracts/api.ts';
import { contractDayAt, displayDay } from '../domain/day.ts';
import { formatUnits } from '../domain/units.ts';
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
  const clock = new Date(now).toISOString();
  const hexDay = displayDay(contractDayAt(BigInt(Math.floor(now / 1000))));
  const totalPayout = estimate?.value ? formatUnits(BigInt(estimate.value.payoutHearts), 8) : null;
  const ready = !!(
    h?.daily?.stakedPercent != null &&
    h.daily.holderCount != null &&
    h.daily.stakerCount != null &&
    rs !== 'unavailable' &&
    ps !== 'unavailable' &&
    cs !== 'unavailable'
  );
  const facts = [
    ['Locked principal (incl. GA)', h?.daily?.stakedHex, 'HEX'],
    ['Circulating supply', h?.daily?.circulatingHex, 'HEX'],
  ] as const;
  return (
    <div className="home-page">
      <h1 className="sr-only">Your daily view</h1>
      <div className="home-clock" aria-label="Current HEX day and UTC time from your device clock">
        <span data-testid="hex-day">
          HEX Day <strong>{hexDay}</strong>
        </span>
        <time dateTime={clock} data-testid="utc-clock">
          {clock.slice(11, 19)} UTC
        </time>
      </div>
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
          title="HEX Price"
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
          title="Payout per T-share"
          value={cs === 'unavailable' ? null : completed?.value?.hexPerTShare}
          unit="HEX/T-share"
          display={compactNumber(completed?.value?.hexPerTShare, 3)}
          note={
            <>
              <span>
                {completed?.value
                  ? 'Completed · ' + dayLabel(completed.value.contractDay)
                  : 'No materialized day'}
              </span>
              <span>{compactObservation(completed, now, cs)}</span>
            </>
          }
        />
        <Metric
          id="rate"
          icon="database"
          title="T-share Rate"
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
          id="staked"
          icon="pie"
          title="% Staked"
          value={h?.daily?.stakedPercent}
          unit="%"
          display={compactNumber(h?.daily?.stakedPercent, 2, false)}
          note={dailyNote}
        />
        <Metric
          id="holders"
          icon="person"
          title="Holders"
          value={h?.daily?.holderCount}
          display={compactNumber(h?.daily?.holderCount, 0, false)}
          note={dailyNote}
        />
        <Metric
          id="stakers"
          icon="people"
          title="Stakers"
          value={h?.daily?.stakerCount}
          display={compactNumber(h?.daily?.stakerCount, 0, false)}
          note={dailyNote}
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
        <div className="home-fact-stack">
          <section className="panel home-facts">
            <div className="home-panel-heading">
              <h2>
                <Icon name="database" />
                Supply &amp; Staking
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
              <div data-metric="duration">
                <dt>Weighted stake length</dt>
                <dd>
                  {compactNumber(yearsFromDays(h?.daily?.weightedStakeLengthDays), 2, false)}
                  {h?.daily?.weightedStakeLengthDays != null && <small> years</small>}
                </dd>
              </div>
            </dl>
            <p className="panel-context">
              Original duration · HEX-weighted · <a href="/learn">Methodology</a>
            </p>
          </section>
          <section className="panel home-today">
            <div className="home-panel-heading">
              <h2>
                <Icon name="calendar" />
                Today in HEX
              </h2>
            </div>
            <p className="panel-context">
              {es !== 'unavailable' && estimate?.value
                ? dayLabel(estimate.value.contractDay)
                : 'No current-day estimate'}
            </p>
            <dl className="fact-rows">
              <div data-metric="estimate">
                <dt>Estimated payout / T-share</dt>
                <dd>
                  {compactNumber(es === 'unavailable' ? null : estimate?.value?.hexPerTShare, 3)}
                  {es !== 'unavailable' && <small> HEX</small>}
                </dd>
              </div>
              <div data-metric="total-estimate">
                <dt>Estimated total payout</dt>
                <dd>
                  {compactNumber(es === 'unavailable' ? null : totalPayout, 2)}
                  {es !== 'unavailable' && <small> HEX</small>}
                </dd>
              </div>
            </dl>
            <p className="panel-context">
              {compactObservation(estimate, now, es)} · estimate, not final
            </p>
          </section>
        </div>
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
            The top clock uses your device’s UTC time and one-based HEX display day, not a source
            block or data freshness claim.
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
                        {key === 'todayPayoutEstimate' && totalPayout != null && (
                          <small className="block">
                            Exact estimated total: {totalPayout} HEX
                            <Copy text={totalPayout} label="Copy estimated total payout" />
                          </small>
                        )}
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
                      ['Holders', h.daily.holderCount, ''],
                      ['Stakers', h.daily.stakerCount, ''],
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
