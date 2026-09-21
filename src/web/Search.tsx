import { Address } from './Address.tsx';
import { useState } from 'react';
import type { z } from 'zod';
import {
  StakesResponseSchema,
  HoldersResponseSchema,
  StakeResponseSchema,
  AddressSchema,
  StakeIdSchema,
} from '../contracts/reads.ts';
import { formatUnits } from '../domain/units.ts';
import { endpoint, useResource, useClock } from './api.ts';
import { dayLabel, numberText } from './format.ts';
import { Feedback, SearchForm, Table, Copy } from './components.tsx';

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
          <h1>Address Lookup</h1>
          <p>Look up an address or stake. Browse dated, accepted index records.</p>
        </div>
      </div>
      <div className="address-search">
        <SearchForm />
      </div>
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
