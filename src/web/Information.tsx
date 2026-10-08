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
          <p>Complete CSV files require current purchased access. Downloads do not spend JSON allowance.</p>
        </div>
      </div>
      <section className="panel">
        <p><strong>SYNTHETIC SAMPLE</strong>: fixed, partial demonstration data.</p>
        <p>{(['daily','stakes','holders','maturities','markets'] as const).map(name => <span key={name}><a download href={`/samples/${name}.csv`}>Sample CSV: {name}</a>{' | '}</span>)}</p>
        <p><a href="/account/">Sign in for complete downloads</a>. A signed-in customer can use the complete download actions below.</p>
      </section>
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
                      Units &amp; coverage <span aria-hidden="true">&rsaquo;</span>
                    </button>
                  </div>
                  <a
                    className="button primary"
                    download
                    aria-label={`Download ${name} CSV`}
                    href={`/api/v2/downloads/${bundle.id}/${name}`}
                  >
                    <Icon name="download" /> Complete CSV
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
        <a href="/learn#methodology">Read the methodology ↗</a>
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
