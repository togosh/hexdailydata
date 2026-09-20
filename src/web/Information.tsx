import { StatusResponseSchema } from '../contracts/api.ts';
import { DownloadsResponseSchema } from '../contracts/reads.ts';
import { reportedHistoryResponseSchema } from '../contracts/history.ts';
import { endpoint, useClock, useResource } from './api.ts';
import { Feedback, Table } from './components.tsx';
import { dayLabel, today, numberText, observationState } from './format.ts';

const descriptions = {
  daily: ['Daily statistics', 'Native daily supply, staking and materialized or pending payouts.'],
  stakes: ['Stakes', 'Accepted indexed stake records, original timing and lifecycle.'],
  holders: ['Holders', 'Current indexed liquid and accounted balances with dated ranks.'],
  maturities: ['Maturities', 'Open future maturities grouped by protocol day.'],
  markets: ['Markets', 'Qualified, separately sourced market observations and interval coverage.'],
};
export function Downloads() {
  const data = useResource(endpoint('/downloads'), DownloadsResponseSchema);
  const bundle = data.data?.bundles.find((b) => b.slot === 'current');
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Take the data with you</p>
          <h1>Downloads</h1>
          <p>Five standard CSV files. Exact amounts, clear units and a fixed cutoff.</p>
        </div>
      </div>
      <Feedback {...data} />
      {bundle ? (
        <>
          <p className="notice">
            Verified catalog · created {bundle.createdAt} · index block{' '}
            {bundle.currentIndex.blockNumber} ({bundle.currentIndex.finality}). Native daily through{' '}
            {bundle.dailyCutoff === null ? 'unavailable' : dayLabel(bundle.dailyCutoff)}. Ranks{' '}
            {bundle.ranking ? dayLabel(bundle.ranking.day) : 'unavailable'}.
          </p>
          <div className="download-grid">
            {bundle.files.map((file) => (
              <section className="panel download-card" key={file.dataset}>
                <span className="file-icon" aria-hidden="true">
                  ↓
                </span>
                <h2>{descriptions[file.dataset][0]} CSV</h2>
                <p>{descriptions[file.dataset][1]}</p>
                <p className="download-count">
                  {numberText(file.rows)} rows · {numberText(file.bytes)} bytes
                </p>
                <a
                  className="button primary"
                  download
                  href={`/api/v2/downloads/${bundle.id}/${file.dataset}`}
                >
                  Download {file.dataset} CSV
                </a>
                <details>
                  <summary>Units &amp; coverage</summary>
                  <p>
                    Snapshot block {bundle.currentIndex.blockNumber}; revision{' '}
                    {bundle.currentIndex.revision}. Origin chains:{' '}
                    {bundle.origins
                      .map((o) => `${o.chainId} (${o.fromBlock}–${o.toBlock})`)
                      .join(', ') || 'not recorded'}
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
                </details>
              </section>
            ))}
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
              Refresh manually when it is ready.
            </p>
            <p>
              Reported archive history remains separately accessible in <a href="/charts">Charts</a>
              .
            </p>
          </section>
        )
      )}
      <section className="panel">
        <h2>Made for reuse</h2>
        <p>
          CSV links stream directly from this server. Files retain their immutable bundle identity.
          If a link has retired, return here and refresh the catalog.
        </p>
        <p>
          Raw token amounts use integer hearts (10⁸ per HEX), shares (10¹² per T-share), or the
          explicitly listed units. Rounded ratios are presentation values.
        </p>
        <a href="/learn">Read the methodology ↗</a>
      </section>
    </>
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
            Home's Stake APY estimates use a 10,000 HEX stake, the current raw share rate and
            today's estimated payout per T-share held constant. Terms are 365, 1825 and 3650 days.
            The calculator's exact amount/duration bonuses and share issuance floors apply. APY is
            (ending HEX / starting HEX) raised to 1 / years, minus 1, expressed as a percentage. It
            annualizes a payout at maturity; rewards do not compound daily. Future payouts,
            penalties and USD prices are not predicted. Expired inputs make the estimates
            unavailable.
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
