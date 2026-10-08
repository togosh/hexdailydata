import { SavedHoldersResponseSchema, UpdatedHolderLookupSchema } from '../contracts/source-update.ts';
import { ACCEPTED } from '../contracts/saved-generation.ts';
import { SourceUpdateDisclosure } from './SourceUpdateDisclosure.tsx';
import type { z } from 'zod';
import { SourceHoldersResponseSchema, SourceHolderLookupSchema, SourceLiquidBalanceSchema, holderAnomaly } from '../contracts/source-holders.ts';
import { sourceUnits } from '../contracts/source-stakes.ts';
import { endpoint, useResource } from './api.ts';
import { SearchForm, Table, Feedback } from './components.tsx';
import { SourceChoice } from './SourceStakes.tsx';
import { numberText } from './format.ts';

const navigate = (url: string) => { history.pushState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); };
export function SavedBrowseChoice({ view }: { view: 'stakes' | 'holders' }) {
  return <label className="view-picker">Browse <select aria-label="Saved records" value={view} onChange={event => {
    const q = new URLSearchParams(location.search); q.delete('cursor'); q.set('source', 'subgraph');
    if (event.target.value === 'holders') q.set('view', 'holders'); else q.delete('view');
    navigate('/search?' + q);
  }}><option value="stakes">Saved stakes</option><option value="holders">Saved holder records</option></select></label>;
}
export function SavedHolderBalance({ holder, liquidBalance }: {
  holder: z.infer<typeof SourceHolderLookupSchema> | z.infer<typeof UpdatedHolderLookupSchema>; liquidBalance: z.infer<typeof SourceLiquidBalanceSchema> | null;
}) {
  const label = (holder.state === 'present_in_saved_inventory' || holder.state === 'present_in_saved_view') && liquidBalance
    ? numberText(liquidBalance.sourceReportedHex, 4) + ' HEX'
    : (holder.state === 'not_present_in_saved_inventory' || holder.state === 'not_present_in_saved_view') ? 'Not in this saved holder view'
    : holder.state === 'source_anomaly' ? 'Source anomaly' : 'Unavailable';
  return <section className="panel source-stakes" data-testid="source-holder-balance" data-state={holder.state}>
    <p className="eyebrow">{'holderDatasetVersion' in holder ? 'Saved subgraph · 5 Oct 2026' : 'Saved source update · 6 Oct 2026'}</p>
    <h2>Reported liquid balance</h2><p className="holder-balance" title={liquidBalance?.sourceReportedHex}>{label}</p>
    {holder.state === 'source_anomaly' && <p>This source record is anomalous. Its reported value is retained below and is not shown as a spendable wallet balance.</p>}
    {'replacementStatus' in holder && holder.replacementStatus === 'rejected' && holder.state !== 'unavailable' && <p role="status">A replacement was rejected. Showing the last accepted saved data.</p>}
    <details className="source-record-evidence"><summary>Original holder values and snapshot</summary>
      <p>{'holderDatasetVersion' in holder ? 'Source-reported values at block 27,720,851, observed 2026-10-05T15:48:05Z.' : 'Base plus observed updates through block 27,724,947. Individual evidence preserves the record observation; this is not a full B1 inventory.'} Display uses 100,000,000 source hearts per HEX. Balances are not independently verified on-chain. Refresh is disabled; reload only rereads local saved data.</p>
      <p>Holder dataset: <code>{'holderDatasetVersion' in holder ? holder.holderDatasetVersion ?? 'Unavailable' : ACCEPTED.familyVersions.tokenHolders}</code>. Individual record timestamps below are separate from this observation.</p>
      <pre>{JSON.stringify(holder, null, 2)}</pre>
    </details>
  </section>;
}

export function SourceHolders() {
  const q = new URLSearchParams(location.search), cursor = q.get('cursor') ?? undefined;
  const holderVersion = q.get('holderDatasetVersion') ?? undefined;
  const data = useResource(endpoint('/holders', { source: 'subgraph', order: 'source-id-asc', limit: 20,
    datasetVersion: holderVersion, generation:q.get('generation') ?? 'base', cursor }), SavedHoldersResponseSchema);
  const body = data.data;
  const reset = () => navigate('/search?source=subgraph&view=holders&generation='+(q.get('generation') ?? 'base'));
  const href = (address: string) => {
    const next = new URLSearchParams({ source: 'subgraph', holderDatasetVersion: body!.datasetVersion });
    next.set('generation', body && 'generation' in body ? body.generation : 'base');
    next.set('datasetVersion', body && 'generation' in body ? body.familyVersions.stakeStarts : ACCEPTED.baseBindings.stakeStarts.datasetVersion);
    return '/address/' + address + '?' + next;
  };
  const amount = (token: string, address: string) => holderAnomaly(token, address) ? 'Source anomaly' : numberText(sourceUnits(token, 8), 4) + ' HEX';
  return <>
    <div className="page-heading"><div><p className="eyebrow">Explore HEX on PulseChain</p><h1>Holder records</h1></div></div>
    <div className="address-search"><SearchForm /></div><SourceChoice /><SavedBrowseChoice view="holders" />
    <section className="panel source-stakes" data-testid="source-holder-list" data-ready={Boolean(body)}>
      <h2>Saved holder inventory</h2>
      {data.code === 'developer_access_required' ? <div role="status"><p>Public browse limit reached. Additional records require an active API key.</p><a href="/api">Developer access</a><button onClick={reset}>Restart public pages</button></div>
        : <Feedback {...data} refresh={data.status === 409 ? reset : data.refresh} />}
      {body && <>
        {'generation' in body ? <SourceUpdateDisclosure /> : <p className="eyebrow">Saved subgraph · 5 Oct 2026</p>}
        {'generation' in body ? <p>{numberText(String(body.localViewRowCount))} records in this local base-plus-updates view. A complete B1 holder population and updated positive count are unproved.</p> : <p>{numberText(String(body.totals.sourceRows))} represented addresses · {numberText(String(body.totals.sourcePositiveAddressCountExcludingZeroAddress))} source-positive addresses. Listed by source ID, without financial ranking.</p>}
        {'replacementStatus' in body && body.replacementStatus === 'rejected' && <p role="status">A replacement was rejected. Showing the last accepted saved data.</p>}
        <details className="source-disclosure"><summary>Source and count definitions</summary>
          <p>pulsechain/hex · block {body.snapshot.number.toLocaleString('en-US')} · {body.snapshot.observedAtUtc}. Refresh disabled; reload only rereads local files.</p>
          <p>These are source records and represented addresses, not people or active stakers. Positive counts exclude the zero address. The original 5 October base census includes 284,162 reported zero balances and one negative zero-address anomaly. These counts are not an updated B1 census. Signed source sums are not token supply.</p>
          <p>Reported display values use 100,000,000 source hearts per HEX. Original tokens and timestamps are available on each address page. Holder dataset <code>{body.datasetVersion}</code>.</p>
        </details>
        <div className="stake-desktop"><Table title="Saved holder records" headings={['Reported address', 'Reported liquid HEX', 'Source state']}>
          {body.items.map(({ reported: row, anomaly }) => <tr key={row.id}>
            <td><a className="address" title={row.holderAddress} href={href(row.holderAddress)}>{row.holderAddress.slice(0, 10)}…{row.holderAddress.slice(-8)}</a></td>
            <td title={anomaly ? 'Original anomalous token is available in address details' : sourceUnits(row.tokenBalance, 8)}>{amount(row.tokenBalance, row.holderAddress)}</td>
            <td>{anomaly ? 'Source anomaly' : 'Reported balance'}</td>
          </tr>)}
        </Table></div>
        <div className="stake-mobile">{body.items.map(({ reported: row }) => <article className="stake-card" key={row.id}>
          <a className="address" title={row.holderAddress} href={href(row.holderAddress)}>{row.holderAddress.slice(0, 10)}…{row.holderAddress.slice(-8)}</a>
          <strong>{amount(row.tokenBalance, row.holderAddress)}</strong>
        </article>)}</div>
        <div className="pager"><button disabled={!cursor} onClick={() => history.back()}>Previous page</button>
          <span>{body.items.length} records on this page</span><button disabled={!body.nextCursor || data.loading} onClick={() => {
            const next = new URLSearchParams(q); next.set('source', 'subgraph'); next.set('view', 'holders'); next.set('cursor', body.nextCursor!); next.set('generation','generation' in body ? body.generation : 'base'); next.set('holderDatasetVersion',body.datasetVersion);
            navigate('/search?' + next);
          }}>Next page</button></div>
      </>}
    </section>
  </>;
}
