import { useState } from 'react';
import { Dialog, Icon } from './visuals.tsx';
import { formatUnits } from '../domain/units.ts';
import { StatusResponseSchema } from '../contracts/api.ts';
import { DownloadsResponseSchema } from '../contracts/reads.ts';
import { reportedHistoryResponseSchema } from '../contracts/history.ts';
import { endpoint, useClock, useResource } from './api.ts';
import { Feedback, Table } from './components.tsx';
import { dayLabel, today, numberText, observationState } from './format.ts';

const descriptions = {
  daily: ['Daily statistics', 'Native daily supply, staking and payouts.', 'chart'],
  stakes: ['Stakes', 'Indexed stakes, timing and lifecycle.', 'database'],
  holders: ['Holders', 'Liquid and accounted staked balances.', 'people'],
  maturities: ['Maturities', 'Open stakes by future maturity day.', 'calendar'],
  markets: ['Markets', 'Qualified market observations and coverage.', 'price'],
} as const;
function downloadSize(raw: string) {
  const bytes = BigInt(raw);
  for (const [divisor, unit] of [
    [1000000000n, 'GB'],
    [1000000n, 'MB'],
    [1000n, 'KB'],
  ] as const) {
    if (bytes >= divisor) return `${formatUnits((bytes * 10n) / divisor, 1)} ${unit}`;
  }
  return `${raw} bytes`;
}
export function Downloads() {
  const data = useResource(endpoint('/downloads'), DownloadsResponseSchema);
  const bundle = data.data?.bundles.find((b) => b.slot === 'current');
  const [selected, setSelected] = useState<string>();
  const file = bundle?.files.find((item) => item.dataset === selected);
  return (
    <div className="downloads-page">
      <div className="page-heading">
        <div>
          <h1>Downloads</h1>
          <p>Grab the core HEX datasets in one tap.</p>
        </div>
      </div>
      {data.loading && <p role="status">Loading downloads...</p>}
      {data.error && <p role="alert">{data.error}</p>}
      {bundle ? (
        <>
          <div className="download-grid">
            {(['stakes', 'holders', 'daily', 'maturities', 'markets'] as const).map((name) => {
              const item = bundle.files.find((entry) => entry.dataset === name)!;
              return (
                <section className="panel download-card" key={name}>
                  <div className="download-card-header">
                    <Icon name={descriptions[name][2]} />
                    <div>
                      <h2>{descriptions[name][0]} CSV</h2>
                      <p>{descriptions[name][1]}</p>
                    </div>
                  </div>
                  <div className="download-meta">
                    <p className="download-count">
                      {numberText(item.rows)} rows &middot;{' '}
                      <span title={`${numberText(item.bytes)} bytes`}>
                        {downloadSize(item.bytes)}
                      </span>
                    </p>
                    <button
                      className="download-details"
                      aria-haspopup="dialog"
                      aria-label={`${descriptions[name][0]} units and coverage`}
                      onClick={() => setSelected(name)}
                    >
                      Units &amp; coverage
                    </button>
                  </div>
                  <a
                    className="button primary"
                    download
                    aria-label={`Download ${name} CSV`}
                    href={`/api/v2/downloads/${bundle.id}/${name}`}
                  >
                    <Icon name="download" /> Download CSV
                  </a>
                </section>
              );
            })}
          </div>
        </>
      ) : (
        !data.loading && (
          <section className="panel">
            <h2>Standard downloads unavailable</h2>
            <p>
              {data.data?.status === 'rebuilding'
                ? 'The standard bundle is rebuilding or has not been published.'
                : 'A verified current catalog is not available.'}{' '}
              Reload this page when it is ready.
            </p>
            <p>
              Reported archive history remains separately accessible in <a href="/charts">Charts</a>
              .
            </p>
          </section>
        )
      )}
      <p>
        <a href="/learn">Read the methodology ↗</a>
      </p>
      {bundle && file && (
        <Dialog
          title={`${descriptions[file.dataset][0]} CSV - Units & coverage`}
          onClose={() => setSelected(undefined)}
        >
          <p className="meta">
            {numberText(file.rows)} rows &middot; {numberText(file.bytes)} bytes
          </p>
          <p>
            Snapshot block {bundle.currentIndex.blockNumber}; revision{' '}
            {bundle.currentIndex.revision}. Origin chains:{' '}
            {bundle.origins.map((o) => `${o.chainId} (${o.fromBlock}–${o.toBlock})`).join(', ') ||
              'not recorded'}
            .
          </p>
          {file.dataset === 'markets' && (
            <p>
              {bundle.markets
                .map(
                  (m) =>
                    `${m.source}: ${m.method}, ${m.qualification}, observed intervals only, day ${m.fromDay + 1}–${m.throughDay === null ? 'pending' : m.throughDay + 1}`,
                )
                .join('; ') || 'No market coverage.'}
            </p>
          )}
          <Table title={`${file.dataset} column units`} headings={['Column', 'Unit']}>
            {file.columns.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td>{c.unit}</td>
              </tr>
            ))}
          </Table>
        </Dialog>
      )}
    </div>
  );
}
export function Learn() {
  return (
    <>
      <p className="eyebrow">A little context goes a long way</p>
      <h1>Learn &amp; methodology</h1>
      <div className="learn-grid">
        <section className="panel">
          <h2>Three different kinds of data</h2>
          <p>
            <strong>Native daily history</strong> follows accepted protocol records. PulseChain
            includes common Ethereum-era native history; inherited stake origins and original dates
            remain visible.
          </p>
          <p>
            <strong>Current observations</strong> are provisional readings at a source block. A
            successful refresh does not make an old source new. Observations are fresh through 120
            seconds, last-known through 30 minutes, then unavailable. Live address pages expire
            sooner under their own pinned cursor.
          </p>
          <p>
            <strong>HDS reported history</strong> is an attributed HEXDailyStats archive,
            independently selectable in Charts. It does not supply Home’s current price, raw share
            rate or calculator presets. Record dates are not proven market-close times.
          </p>
        </section>
        <section className="panel">
          <h2>Amounts, shares &amp; days</h2>
          <p>
            1 HEX = 100,000,000 hearts. 1 T-share = 1,000,000,000,000 shares. T-share rate is HEX
            per T-share before bonuses, never an APY.
          </p>
          <p>
            Raw integers and published decimal tokens are preserved. Compact Home values may be
            truncated; their full received value is in the title. Chart tables retain full published
            precision. Approximate chart coordinates never feed calculations.
          </p>
          <p>
            Contract days start at 00:00 UTC on December 3, 2019. Display days add one. Ordinary
            stakes lock next day, with the launch lock floor preserved, and mature after their whole
            staked duration.
          </p>
        </section>
        <section className="panel">
          <h2>Supply &amp; duration</h2>
          <p>
            Percentage staked uses locked principal divided by circulating plus locked HEX. Locked
            principal includes good-accounted stakes. Native principal-weighted original duration
            excludes good-accounted and ended stakes and is shown in days.
          </p>
          <p>
            HDS duration is reported in 365-day years. HDS total HEX is circulating plus locked, not
            ERC20 totalSupply. Current holders differ from historical-ever holders. Do not combine
            those series without their definitions.
          </p>
        </section>
        <section className="panel">
          <h2>Payout &amp; calculator assumptions</h2>
          <p>
            Home's Stake APY estimates use a 10,000 HEX stake, the current raw share rate and the
            arithmetic mean payout per T-share over 30 consecutive completed days, ending at the
            latest indexed completed payout, held constant. Penalties included in those daily
            payouts remain included. Missing or pending days make the average unavailable. Terms are
            365, 1825 and 3650 days. The calculator's exact amount/duration bonuses and share
            issuance floors apply. APY is (ending HEX / starting HEX) raised to 1 / years, minus 1,
            expressed as a percentage. It annualizes a payout at maturity; rewards do not compound
            daily. Future payouts, penalties and USD prices are not predicted. An expired share rate
            or unavailable history makes the estimates unavailable.
          </p>
          <p>
            A completed payout belongs to its actual materialized day. Today’s payout is an estimate
            and cannot become final merely through polling. Missing ledger rounds remain pending.
          </p>
          <p>
            The calculator applies the ordinary new-stake amount and duration bonus with one
            combined integer floor, then floors share issuance at the raw rate. Its optional payout
            scenario holds the exact selected 1/30/365-day mean of daily payout ratios constant. No
            compounding, future yield or USD price is promised.
          </p>
        </section>
      </div>
      <section className="panel">
        <h2>Stake status glossary</h2>
        <dl className="glossary">
          <dt>Queued</dt>
          <dd>Created but not yet locked for payout.</dd>
          <dt>Open</dt>
          <dd>Locked and not ended or good-accounted.</dd>
          <dt>Mature, open</dt>
          <dd>Term completed; still open. Maturity is not automatic settlement.</dd>
          <dt>Good accounted (GA)</dt>
          <dd>Payout accounting was performed; principal remains locked until stake end.</dd>
          <dt>Ended</dt>
          <dd>Stake has settled; recorded payout and penalty remain historical.</dd>
          <dt>Cancelled</dt>
          <dd>Ended before locking. It is not an ordinary completed-term payout.</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>Coverage is explicit</h2>
        <p>
          Missing prices and dates break chart lines. HDS same-date rows remain separate by
          sourceDay. Reference prices contain only admitted post-fork PulseChain observations, with
          no Ethereum price seam. Native index coverage, archive coverage, market coverage and
          download availability are independent.
        </p>
        <p>
          Rank is dated. A live page is a bounded observation, not proof that every stake was
          fetched. Provider unavailability or index lag never establishes absence.
        </p>
        <a href="/status">Inspect data status ↗</a> ·{' '}
        <a href="/api/v2/status?chain=pulsechain">Current API metadata</a>
      </section>
    </>
  );
}
export function Status() {
  const now = useClock();
  const data = useResource(endpoint('/status'), StatusResponseSchema);
  const archive = useResource(
    endpoint('/daily', { source: 'hexdailystats', from: today(), to: today() }),
    reportedHistoryResponseSchema,
  );
  const streams = (data.data?.streams ?? []).map((s) => ({
    ...s,
    freshness: observationState(
      { status: s.freshness, asOf: s.asOf, observedAt: s.asOf.blockTimestamp },
      now,
    ),
  }));
  const currentStream = streams.find((s) => s.chain === data.data?.chain);
  const indexState =
    data.data?.state === 'current' && currentStream?.freshness !== 'fresh'
      ? 'degraded'
      : data.data?.state;
  return (
    <>
      <p className="eyebrow">Coverage &amp; freshness</p>
      <h1>Data status</h1>
      <Feedback {...data} />
      <section className="panel">
        <h2>Native data</h2>
        {data.data ? (
          <>
            <dl className="summary-grid">
              <div>
                <dt>Database at last response</dt>
                <dd>{data.data.database}</dd>
              </div>
              <div>
                <dt>Index</dt>
                <dd>{indexState}</dd>
              </div>
              <div>
                <dt>Providers</dt>
                <dd>{data.data.liveProvidersEnabled ? 'Enabled' : 'Disabled'}</dd>
              </div>
              <div>
                <dt>Launch qualification</dt>
                <dd>Pending</dd>
              </div>
            </dl>
            <p>
              Offline implementation is separate from native initialization and live-source
              qualification.
            </p>
            {streams.map((s) => (
              <p key={s.chain}>
                {s.chain} · block {s.asOf.blockNumber} · {s.freshness} · source{' '}
                {s.asOf.blockTimestamp}. Daily through{' '}
                {s.dailyThroughDay === null ? 'unavailable' : dayLabel(s.dailyThroughDay)}.
              </p>
            ))}
            <Table
              title="Independent current observations"
              headings={['Metric', 'State', 'Source block time', 'Collected']}
            >
              {data.data.observations.map((o) => (
                <tr key={o.chain + o.metric}>
                  <td>
                    {o.chain} · {o.metric}
                  </td>
                  <td>{observationState(o, now)}</td>
                  <td>{o.asOf?.blockTimestamp ?? 'Unavailable'}</td>
                  <td>{o.observedAt ?? 'Unavailable'}</td>
                </tr>
              ))}
            </Table>
            {data.data.markets.map((m) => (
              <p key={m.chain + m.source}>
                Market {m.source} · {m.state} · through{' '}
                {m.throughDay === null ? 'unavailable' : dayLabel(m.throughDay)}
              </p>
            ))}
          </>
        ) : (
          <p>Native status unavailable.</p>
        )}
      </section>
      <section className="panel">
        <h2>HDS reported archive</h2>
        <Feedback {...archive} />
        {archive.data ? (
          <>
            <p>
              Available independently of the native index:{' '}
              {archive.data.metadata.summary.firstRecordDateUtc}–
              {archive.data.metadata.summary.lastRecordDateUtc}.
            </p>
            <p>
              {archive.data.metadata.summary.records} records ·{' '}
              {archive.data.metadata.summary.prices} admitted reference prices. Acquired{' '}
              {archive.data.metadata.selection.provenance.acquiredAt}.
            </p>
            <p>Source-record dates; market period unproved.</p>
            <a href="/charts">Browse archive ↗</a>
          </>
        ) : (
          <p>Archive metadata unavailable or not imported.</p>
        )}
      </section>
    </>
  );
}
