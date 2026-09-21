import { useRef, useState } from 'react';
import type { z } from 'zod';
import {
  StakesResponseSchema,
  HoldersResponseSchema,
  AddressResultSchema,
  StakeResponseSchema,
  AddressSchema,
  StakeIdSchema,
} from '../contracts/reads.ts';
import { formatUnits } from '../domain/units.ts';
import { endpoint, useResource, useClock } from './api.ts';
import { dayLabel, numberText } from './format.ts';
import { Icon } from './visuals.tsx';
import { Feedback, SearchForm, Table, Copy, Value, Metric } from './components.tsx';

const statusName = (s: string) =>
  ({
    queued: 'Queued',
    open: 'Open',
    mature_open: 'Mature, open',
    good_accounted: 'Good accounted',
    ended: 'Ended',
    cancelled: 'Cancelled',
  })[s] ?? s;
const hex = (v: string | null | undefined) => (v == null ? null : formatUnits(BigInt(v), 8));
function StakeTable({ items }: { items: z.infer<typeof StakesResponseSchema>['items'] }) {
  return (
    <Table
      title="Accepted indexed stakes"
      headings={[
        'Stake ID / owner',
        'Principal (HEX)',
        'T-shares',
        'Maturity (UTC)',
        'Status / origin',
      ]}
    >
      {items.map((s) => (
        <tr key={s.stakeId}>
          <td>
            <a href={'/stake/' + s.stakeId}>{s.stakeId}</a>
            <br />
            <a className="address" href={'/address/' + s.address}>
              {s.address}
            </a>
          </td>
          <td>{numberText(formatUnits(BigInt(s.principalHearts), 8))}</td>
          <td>{numberText(formatUnits(BigInt(s.stakeShares), 12))}</td>
          <td>{dayLabel(s.maturityDay)}</td>
          <td>
            {statusName(s.status)}
            <small className="block">
              {s.originChainId === 1 ? 'Inherited Ethereum' : 'PulseChain'} · started {s.startedAt}
            </small>
          </td>
        </tr>
      ))}
    </Table>
  );
}
function Indexed({ address, order = 'stakes' }: { address?: string; order?: string }) {
  const [cursor, setCursor] = useState<string>(),
    [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const ranks = order !== 'stakes';
  const stakeData = useResource(
    !ranks ? endpoint('/stakes', { limit: 20, address, cursor }) : null,
    StakesResponseSchema,
  );
  const rankData = useResource(
    ranks ? endpoint('/holders', { limit: 20, order, cursor }) : null,
    HoldersResponseSchema,
  );
  const data = ranks ? rankData : stakeData;
  const reset = () => {
    setCursor(undefined);
    setPrevious([]);
    data.refresh();
  };
  return (
    <section className="panel">
      <h2>
        {ranks ? (order === 'staker' ? 'Staker ranks' : 'Liquid-holder ranks') : 'Indexed stakes'}
      </h2>
      <Feedback {...data} refresh={data.status === 409 ? reset : data.refresh} />
      {data.status === 409 ? (
        <button onClick={reset}>Restart indexed pages</button>
      ) : (
        data.data && (
          <>
            <p className="meta">
              Accepted index · block {data.data.cutoff.asOf.blockNumber} ·{' '}
              {data.data.cutoff.finality} · {data.data.cutoff.asOf.blockTimestamp}. This is a
              bounded page, not the current live stake list.
            </p>
            {ranks && rankData.data ? (
              <>
                <p>
                  Rank at {dayLabel(rankData.data.rankingDay)} · block{' '}
                  {rankData.data.rankAsOf.blockNumber}
                </p>
                <Table
                  title="Dated global ranks"
                  headings={[
                    'Rank',
                    'Address',
                    'Liquid HEX',
                    'Accounted HEX',
                    'Indexed stake count',
                  ]}
                >
                  {rankData.data.items.map((r) => (
                    <tr key={r.address}>
                      <td>{ranks && order === 'staker' ? r.stakerRank : r.liquidRank}</td>
                      <td>
                        <a className="address" href={'/address/' + r.address}>
                          {r.address}
                        </a>
                      </td>
                      <td>{numberText(hex(r.liquidHearts))}</td>
                      <td>{numberText(hex(r.accountedHearts))}</td>
                      <td>{r.stakeCount}</td>
                    </tr>
                  ))}
                </Table>
              </>
            ) : (
              stakeData.data && <StakeTable items={stakeData.data.items} />
            )}
            {!data.data.items.length && (
              <p>No indexed rows at this cutoff. This does not establish current-chain absence.</p>
            )}
            <div className="pager">
              <button
                disabled={!previous.length || data.loading}
                onClick={() => {
                  setCursor(previous.at(-1));
                  setPrevious(previous.slice(0, -1));
                }}
              >
                Previous page
              </button>
              <span>{data.data.items.length} rows on this page</span>
              <button
                disabled={!data.data.nextCursor || data.loading}
                onClick={() => {
                  setPrevious([...previous, cursor]);
                  setCursor(data.data!.nextCursor!);
                }}
              >
                Next page
              </button>
            </div>
          </>
        )
      )}
    </section>
  );
}
function Address({ address }: { address: string }) {
  const [cursor, setCursor] = useState<string>();
  const pinned = useRef<string | null>(null);
  const data = useResource(
    endpoint('/addresses/' + address + (cursor ? '/stakes' : ''), { limit: 20, cursor }),
    AddressResultSchema,
  );
  const now = useClock(),
    d = data.data,
    page = d?.live?.page;
  const identity = page
    ? page.asOf.blockHash + ':' + page.stakeCount + ':' + d?.live?.expiresAt
    : null;
  const conflict = !!(cursor && identity && identity !== pinned.current);
  const expired = !!(d?.live && Date.parse(d.live.expiresAt) <= now);
  const valid = !conflict && !expired && data.status !== 409;
  const restart = () => {
    pinned.current = null;
    setCursor(undefined);
    data.refresh();
  };
  return (
    <div className="address-page">
      <div className="page-heading">
        <div>
          <h1>Address Lookup</h1>
          <p>Search an address or stake ID to view balances, stakes and dated ranks.</p>
        </div>
      </div>
      <div className="address-search">
        <SearchForm />
      </div>
      <div className="address-feedback">
        <Feedback {...data} refresh={restart} hasData={!!d} />
      </div>
      <dl className="address-metrics">
        <Metric
          id="address-liquid"
          icon="database"
          title="Liquid HEX"
          value={valid && d?.live ? hex(d.live.balanceHearts) : null}
          note="Current observed block"
        />
        <Metric
          id="address-count"
          icon="people"
          title="Current stakes"
          value={valid && page ? page.stakeCount : null}
          note="Current observed block"
        />
        <Metric
          id="address-accounted"
          icon="pie"
          title="Accounted staked HEX"
          value={hex(d?.indexed?.accountedHearts)}
          note="Indexed; excludes good-accounted stakes"
        />
        <Metric
          id="address-rank"
          icon="chart"
          title="Liquid rank"
          value={d?.indexed?.rank?.liquid}
          prefix="#"
          note={
            d?.indexed?.rankingDay == null
              ? 'Rank date unavailable'
              : dayLabel(d.indexed.rankingDay)
          }
        />
      </dl>
      <div className="address-layout">
        <section className="panel address-stakes">
          <h2>
            <Icon name="database" /> Current stakes
          </h2>
          {!valid ? (
            <p className="notice">
              Observation changed or expired. Restart to read a new pinned page.
            </p>
          ) : d?.live ? (
            <>
              <p className="meta">
                Provisional · block {page!.asOf.blockNumber} · source {page!.asOf.blockTimestamp} ·
                collected {page!.observedAt}
              </p>

              <p>
                Showing {page!.items.length} of {page!.stakeCount} current stakes · offset{' '}
                {d.live.offset}.{' '}
                {page!.enumerationComplete
                  ? 'Enumeration complete at this observation.'
                  : 'Partial page; whole-address stake totals and nearest maturity are not inferred.'}
              </p>
              <Table
                title="Pinned current stake page"
                headings={[
                  'Stake ID',
                  'Principal (HEX)',
                  'T-shares',
                  'Lock / maturity (UTC)',
                  'State',
                ]}
              >
                {page!.items.map((s) => (
                  <tr key={s.stakeId}>
                    <td>
                      <a href={'/stake/' + s.stakeId}>{s.stakeId}</a>
                    </td>
                    <td>{numberText(hex(s.principalHearts))}</td>
                    <td>{numberText(formatUnits(BigInt(s.stakeShares), 12))}</td>
                    <td>
                      {dayLabel(s.lockedDay)}
                      <br />
                      {dayLabel(s.lockedDay + s.stakedDays)}
                    </td>
                    <td>
                      <span className="address-state">
                        {s.unlockedDay ? 'Good accounted' : 'Current at observed block'}
                      </span>
                      {s.isAutoStake ? ' · auto-stake' : ''}
                    </td>
                  </tr>
                ))}
              </Table>
              <button
                disabled={!page!.nextCursor || data.loading}
                onClick={() => {
                  pinned.current = identity;
                  setCursor(page!.nextCursor!);
                }}
              >
                Next pinned page
              </button>
            </>
          ) : (
            <p>
              Current balance and stakes unavailable
              {d?.outcome === 'quota' ? ' — provider quota reached' : ''}. Indexed records below
              have their own cutoff.
            </p>
          )}
          {(!valid || cursor) && <button onClick={restart}>Restart current observation</button>}
        </section>
        <aside className="panel address-summary">
          <h2>
            <Icon name="person" /> Address Summary
          </h2>
          <dl className="fact-rows">
            <div>
              <dt>Address</dt>
              <dd className="address-summary-id" title={address}>
                {address.slice(0, 8)}...{address.slice(-6)}
              </dd>
            </div>
            <div>
              <dt>Current stake count</dt>
              <dd>{valid && page ? numberText(page.stakeCount) : 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Liquid rank</dt>
              <dd>
                {d?.indexed?.rank?.liquid ? '#' + numberText(d.indexed.rank.liquid) : 'Unavailable'}
              </dd>
            </div>
            <div>
              <dt>Staker rank</dt>
              <dd>
                {d?.indexed?.rank?.staker ? '#' + numberText(d.indexed.rank.staker) : 'Unavailable'}
              </dd>
            </div>
            <div>
              <dt>Rank date</dt>
              <dd>
                {d?.indexed?.rankingDay == null ? 'Unavailable' : dayLabel(d.indexed.rankingDay)}
              </dd>
            </div>
          </dl>
          <Copy text={address} label="Copy address" />
          <details className="address-source-details">
            <summary>Full address &amp; source details</summary>
            <p className="full-address">{address}</p>
            {d?.indexed && (
              <p className="meta">
                Rank block {d.indexed.rank?.asOf.blockNumber ?? 'unavailable'}. Indexed block{' '}
                {d.indexed.asOf.blockNumber} - {d.indexed.asOf.blockTimestamp} -{' '}
                {d.indexed.finality}.
              </p>
            )}
          </details>
          {d?.indexed && (
            <div className="address-baseline">
              <h3>Accepted indexed baseline</h3>
              <dl className="fact-rows">
                <div>
                  <dt>Indexed liquid HEX</dt>
                  <dd>
                    <Value value={hex(d.indexed.liquidHearts)} places={4} />
                  </dd>
                </div>
                <div>
                  <dt>Indexed accounted HEX (excludes GA)</dt>
                  <dd>
                    <Value value={hex(d.indexed.accountedHearts)} places={4} />
                  </dd>
                </div>
                <div>
                  <dt>Indexed stake count</dt>
                  <dd>{d.indexed.stakeCount ?? 'Unavailable'}</dd>
                </div>
              </dl>
              <p className="meta">
                Block {d.indexed.asOf.blockNumber} - {d.indexed.finality}
              </p>
            </div>
          )}
        </aside>
      </div>
      <details className="address-indexed">
        <summary>Indexed stake records</summary>
        <Indexed address={address} />
      </details>
    </div>
  );
}
function Stake({ id }: { id: string }) {
  const data = useResource(endpoint('/stakes/' + id), StakeResponseSchema);
  const now = useClock(),
    s = data.data?.indexed,
    recent = data.data?.recent;
  const recentValid = recent?.expiresAt && Date.parse(recent.expiresAt) > now;
  return (
    <>
      <h1>Stake {id}</h1>
      <SearchForm />
      <Feedback {...data} />
      {s && (
        <section className="panel">
          <h2>{statusName(s.status)}</h2>
          <p>
            Owner{' '}
            <a className="address" href={'/address/' + s.address}>
              {s.address}
            </a>
          </p>
          <dl className="summary-grid">
            <div>
              <dt>Principal HEX</dt>
              <dd>{numberText(hex(s.principalHearts))}</dd>
            </div>
            <div>
              <dt>T-shares</dt>
              <dd>{numberText(formatUnits(BigInt(s.stakeShares), 12))}</dd>
            </div>
            <div>
              <dt>Original duration</dt>
              <dd>{s.stakedDays} days</dd>
            </div>
            <div>
              <dt>Maturity</dt>
              <dd>{dayLabel(s.maturityDay)}</dd>
            </div>
          </dl>
          <p>
            Started {s.startedAt} · {dayLabel(s.startDay)} ·{' '}
            {s.originChainId === 1 ? 'inherited Ethereum origin' : 'PulseChain origin'} · start
            block {s.startBlock}.
          </p>
          <p>
            Locks {dayLabel(s.lockedDay)}.{' '}
            {s.isAutoStake ? 'Inherited auto-stake.' : 'Ordinary stake.'}
          </p>
          {s.goodAccountedAt && (
            <p>
              Good accounting: {s.goodAccountedAt} · origin chain {s.gaOriginChainId}.
            </p>
          )}
          {s.endedAt && (
            <p>
              Ended {s.endedAt} · origin chain {s.endOriginChainId}. Payout{' '}
              {numberText(hex(s.payoutHearts))} HEX; penalty {numberText(hex(s.penaltyHearts))} HEX.
            </p>
          )}
          <p className="meta">
            Index cutoff block {data.data?.cutoff?.asOf.blockNumber} · {data.data?.cutoff?.finality}
          </p>
          <Copy text={s.stakeId} label="Copy stake ID" />
        </section>
      )}
      {recent && (
        <section className="panel">
          <h2>Recent observation</h2>
          <p>
            {recent.outcome === 'absent'
              ? 'Confirmed absent within the accepted lookup.'
              : recent.outcome === 'indexing'
                ? 'Index is catching up. Lookup is inconclusive.'
                : recent.outcome === 'unavailable' || recent.outcome === 'quota'
                  ? 'Recent provider observation unavailable. No current absence is inferred.'
                  : !recentValid
                    ? 'Recent observation expired. Refresh to restart.'
                    : recent.outcome.replaceAll('_', ' ')}
          </p>
          {recent.live && recentValid && (
            <p>
              {numberText(hex(recent.live.principalHearts))} HEX ·{' '}
              {numberText(formatUnits(BigInt(recent.live.stakeShares), 12))} T-shares · provisional
              block {recent.observation?.blockNumber} · observed {recent.observedAt}.
            </p>
          )}
        </section>
      )}
    </>
  );
}
export default function Search({ path }: { path: string }) {
  const [order, setOrder] = useState('stakes');
  if (path.startsWith('/address/')) {
    const address = AddressSchema.safeParse(path.slice(9));
    return address.success ? (
      <Address key={address.data} address={address.data} />
    ) : (
      <>
        <h1>Invalid address</h1>
        <SearchForm />
      </>
    );
  }
  if (path.startsWith('/stake/')) {
    const id = StakeIdSchema.safeParse(path.slice(7));
    return id.success ? (
      <Stake id={id.data} />
    ) : (
      <>
        <h1>Invalid stake ID</h1>
        <SearchForm />
      </>
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Explore HEX on PulseChain</p>
          <h1>Search &amp; rankings</h1>
          <p>Look up an address or stake. Browse dated, accepted index records.</p>
        </div>
      </div>
      <SearchForm />
      <label className="view-picker">
        Browse
        <select aria-label="Browse" value={order} onChange={(e) => setOrder(e.target.value)}>
          <option value="stakes">Indexed stakes</option>
          <option value="liquid">Liquid-holder ranks</option>
          <option value="staker">Staker ranks</option>
        </select>
      </label>
      <Indexed key={order} order={order} />
    </>
  );
}
