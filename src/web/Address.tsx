import { useRef, useState } from 'react';
import type { z } from 'zod';
import { AddressResultSchema, StakesResponseSchema } from '../contracts/reads.ts';
import type { IndexedAddress } from '../contracts/api.ts';
import { formatUnits } from '../domain/units.ts';
import { endpoint, useResource, useClock } from './api.ts';
import { dayLabel, dayDate, compactNumber, numberText } from './format.ts';
import { Icon } from './visuals.tsx';
import { Feedback, SearchForm, Table, Copy, Metric } from './components.tsx';

const hex = (value: string | null | undefined) =>
  value == null ? null : formatUnits(BigInt(value), 8);
const shares = (value: string | null | undefined) =>
  value == null ? null : formatUnits(BigInt(value), 12);
const stateName = (state: string) =>
  ({
    queued: 'Queued',
    open: 'Active',
    mature_open: 'Mature, open',
    good_accounted: 'Good accounted',
    ended: 'Ended',
    cancelled: 'Cancelled',
  })[state] ?? state;
const filters = [
  ['open', 'Open', 'openCount'],
  ['good_accounted', 'Good Accounted', 'goodAccountedCount'],
  ['ended', 'Ended', 'endedCount'],
] as const;
type Filter = (typeof filters)[number][0];
type Stake = z.infer<typeof StakesResponseSchema>['items'][number];

function StakeRows({ items, day }: { items: Stake[]; day: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="stake-desktop">
        <Table
          title="Accepted indexed stakes"
          headings={[
            'Stake ID',
            'Principal HEX',
            'T-Shares',
            'Start / maturity (UTC)',
            'Days left',
            'State',
          ]}
        >
          {items.map((s) => (
            <tr key={s.stakeId}>
              <td>
                <a href={'/stake/' + s.stakeId}>#{s.stakeId}</a>
              </td>
              <td title={hex(s.principalHearts)!}>{compactNumber(hex(s.principalHearts), 3)}</td>
              <td title={shares(s.stakeShares)!}>{compactNumber(shares(s.stakeShares), 3)}</td>
              <td title={`Start day ${s.startDay + 1} · maturity day ${s.maturityDay + 1}`}>
                <small>{dayDate(s.startDay)}</small>
                <br />
                {dayDate(s.maturityDay)}
              </td>
              <td>
                {['queued', 'open', 'mature_open'].includes(s.status)
                  ? Math.max(0, s.maturityDay - day)
                  : '—'}
              </td>
              <td>
                <span className={'address-state state-' + s.status}>{stateName(s.status)}</span>
              </td>
            </tr>
          ))}
        </Table>
      </div>
      <div className="stake-mobile">
        {items.slice(0, expanded ? undefined : 4).map((s) => (
          <article className="stake-card" key={s.stakeId}>
            <div>
              <a href={'/stake/' + s.stakeId}>#{s.stakeId}</a>
              <span className={'address-state state-' + s.status}>{stateName(s.status)}</span>
            </div>
            <div className="stake-card-values">
              <strong title={hex(s.principalHearts)!}>
                {compactNumber(hex(s.principalHearts), 3)} <small>HEX</small>
              </strong>
              <span title={shares(s.stakeShares)!}>
                {compactNumber(shares(s.stakeShares), 3)} <small>T-Shares</small>
              </span>
            </div>
            <p>
              Day {s.maturityDay + 1} · {dayDate(s.maturityDay)}
              {['queued', 'open', 'mature_open'].includes(s.status)
                ? ` · ${Math.max(0, s.maturityDay - day)}d left`
                : ''}
            </p>
          </article>
        ))}
        {items.length > 4 && (
          <button className="view-stakes" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show fewer' : `View all ${items.length} on this page`}{' '}
            <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
    </>
  );
}

function IndexedStakes({
  address,
  indexed,
  filter,
}: {
  address: string;
  indexed?: IndexedAddress | null;
  filter: Filter;
}) {
  const [cursor, setCursor] = useState<string>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const data = useResource(
    endpoint('/stakes', { address, lifecycle: filter, limit: 20, cursor }),
    StakesResponseSchema,
  );
  const d = data.data;
  const reset = () => {
    setCursor(undefined);
    setPrevious([]);
    data.refresh();
  };
  return (
    <>
      <div className="stake-toolbar">
        {d && (
          <p className="meta stake-cutoff">
            INDEXED · {d.cutoff.asOf.blockTimestamp.slice(0, 10)} · block{' '}
            {d.cutoff.asOf.blockNumber}
          </p>
        )}
        <Feedback {...data} hasData={!!d} refresh={reset} />
      </div>
      {data.status === 409 ? (
        <button onClick={reset}>Restart indexed pages</button>
      ) : (
        d && (
          <>
            {indexed && indexed.asOf.blockHash !== d.cutoff.asOf.blockHash && (
              <p className="notice">
                List and summary have different cutoffs. Refresh the address to update its counts.
              </p>
            )}
            <StakeRows key={cursor ?? 'first'} items={d.items} day={d.cutoff.contractDay} />
            {!d.items.length && (
              <p>
                No {filter === 'good_accounted' ? 'good-accounted' : filter} stakes at this indexed
                cutoff.
              </p>
            )}
            {(previous.length > 0 || d.nextCursor) && (
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
                <span>Page {previous.length + 1}</span>
                <button
                  disabled={!d.nextCursor || data.loading}
                  onClick={() => {
                    setPrevious([...previous, cursor]);
                    setCursor(d.nextCursor!);
                  }}
                >
                  Next page
                </button>
              </div>
            )}
          </>
        )
      )}
    </>
  );
}

export function Address({ address }: { address: string }) {
  const [cursor, setCursor] = useState<string>();
  const [filter, setFilter] = useState<Filter>('open');
  const pinned = useRef<string | null>(null);
  const data = useResource(
    endpoint('/addresses/' + address + (cursor ? '/stakes' : ''), { limit: 20, cursor }),
    AddressResultSchema,
  );
  const now = useClock(),
    d = data.data,
    page = d?.live?.page,
    index = d?.indexed,
    staking = index?.staking;
  const identity = page
    ? page.asOf.blockHash + ':' + page.stakeCount + ':' + d?.live?.expiresAt
    : null;
  const conflict = !!(cursor && identity && identity !== pinned.current);
  const expired = !!(d?.live && Date.parse(d.live.expiresAt) <= now);
  const invalidated = expired || conflict || data.status === 409 || d?.outcome === 'expired';
  const valid = !conflict && !expired && !data.error && data.status !== 409;
  const restart = () => {
    pinned.current = null;
    setCursor(undefined);
    data.refresh();
  };
  const liveLabel =
    valid && page
      ? `LIVE · block ${page.asOf.blockNumber}`
      : invalidated
        ? 'LIVE · expired'
        : 'LIVE · unavailable';
  const indexLabel = index
    ? `INDEXED · ${index.asOf.blockTimestamp.slice(0, 10)}`
    : 'INDEXED · unavailable';
  const next = staking?.nextMaturityDay;
  const currentCount = staking
    ? (BigInt(staking.openCount) + BigInt(staking.goodAccountedCount)).toString()
    : null;
  return (
    <div className="address-page">
      <div className="page-heading">
        <div>
          <h1>Address Lookup</h1>
          <p>HEX balances, stakes and dated ranks.</p>
        </div>
        <div className="address-feedback">
          <Feedback {...data} refresh={restart} hasData={!!d} />
        </div>
      </div>
      <div className="address-search">
        <Icon name="search" />
        <SearchForm />
      </div>
      <div className="address-freshness">
        <span>{liveLabel}</span>
        <span>{indexLabel}</span>
        {valid && page && (
          <span>
            {page.items.length} / {page.stakeCount} live verified
            {d?.live?.offset !== '0' ? ` · offset ${d?.live?.offset}` : ''}
          </span>
        )}
      </div>
      <dl className="address-metrics">
        <Metric
          id="address-liquid"
          icon="database"
          title="Liquid HEX"
          value={valid && d?.live ? hex(d.live.balanceHearts) : null}
          display={compactNumber(valid && d?.live ? hex(d.live.balanceHearts) : null, 3)}
          note="Live · pinned balance"
        />
        <Metric
          id="address-staked"
          icon="pie"
          title="Staked HEX"
          value={hex(staking?.lockedHearts)}
          display={compactNumber(hex(staking?.lockedHearts), 3)}
          note="Indexed · includes GA"
        />
        <Metric
          id="address-shares"
          icon="chart"
          title="T-Shares"
          value={shares(staking?.accountedShares)}
          display={compactNumber(shares(staking?.accountedShares), 3)}
          note="Indexed · excludes GA"
        />
        <Metric
          id="address-maturity"
          icon="calendar"
          title="Next Maturity"
          emptyLabel={staking ? 'None upcoming' : 'Unavailable'}
          value={next == null ? null : String(next + 1)}
          display={next == null ? 'None upcoming' : 'Day ' + (next + 1)}
          note={
            next == null
              ? staking
                ? 'No upcoming indexed maturity'
                : 'Index unavailable'
              : dayDate(next) + ' · indexed'
          }
        />
      </dl>
      <div className="address-layout">
        <section className="panel address-stakes">
          <h2>
            <Icon name="database" /> Stakes <span className="heading-note">Accepted index</span>
          </h2>
          <div className="stake-filters" role="group" aria-label="Stake lifecycle">
            {filters.map(([key, name, count]) => (
              <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {name}
                {staking && (
                  <>
                    {' '}
                    <span>{numberText(staking[count])}</span>
                  </>
                )}
              </button>
            ))}
          </div>
          <IndexedStakes key={filter} address={address} indexed={index ?? null} filter={filter} />
        </section>
        <aside className="panel address-summary">
          <h2>
            <Icon name="person" /> Address Summary
          </h2>
          <dl className="fact-rows">
            <div>
              <dt>Address</dt>
              <dd className="address-summary-id" title={address}>
                {address.slice(0, 8)}…{address.slice(-6)}
              </dd>
            </div>
            <div>
              <dt>Current / open</dt>
              <dd>
                {numberText(currentCount)} / {numberText(staking?.openCount)}
              </dd>
            </div>
            <div>
              <dt>Liquid rank</dt>
              <dd>{index?.rank?.liquid ? '#' + numberText(index.rank.liquid) : 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Staker rank</dt>
              <dd>{index?.rank?.staker ? '#' + numberText(index.rank.staker) : 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Rank date</dt>
              <dd>{index?.rankingDay == null ? 'Unavailable' : dayDate(index.rankingDay)}</dd>
            </div>
            <div>
              <dt>First stake</dt>
              <dd>
                {staking?.firstStakeDay == null ? (
                  staking ? (
                    'None indexed'
                  ) : (
                    'Unavailable'
                  )
                ) : (
                  <>
                    Day {staking.firstStakeDay + 1}
                    <small className="block">{dayDate(staking.firstStakeDay)}</small>
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>Next maturity</dt>
              <dd>
                {next == null ? (
                  staking ? (
                    'None upcoming'
                  ) : (
                    'Unavailable'
                  )
                ) : (
                  <>
                    Day {next + 1}
                    <small className="block">{dayDate(next)}</small>
                  </>
                )}
              </dd>
            </div>
          </dl>
          <Copy text={address} label="Copy address" />
          <p className="meta">{indexLabel} · current = open + good accounted</p>
        </aside>
      </div>
      <section className="panel address-activity">
        <h2>
          <Icon name="clock" /> Stake Activity{' '}
          <span className="heading-note">Latest 5 indexed lifecycle events</span>
        </h2>
        {staking?.activity.length ? (
          <ol>
            {staking.activity.map((a) => (
              <li key={a.stakeId + a.kind}>
                <time dateTime={a.at}>{a.at.slice(0, 10)}</time>
                <strong>
                  {
                    {
                      start: 'Start',
                      good_accounting: 'Good accounting',
                      end: 'End',
                      cancel: 'Cancellation',
                    }[a.kind]
                  }
                </strong>
                <a href={'/stake/' + a.stakeId}>#{a.stakeId}</a>
                <small>{a.originChainId === 1 ? 'Inherited Ethereum' : 'PulseChain'}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p>{staking ? 'No indexed stake activity.' : 'Indexed activity unavailable.'}</p>
        )}
        <p className="meta">{indexLabel} · stake lifecycle only; excludes transfers and claims.</p>
      </section>
      <details className="panel address-data-details">
        <summary>Data details</summary>
        <p className="full-address">{address}</p>
        <p>
          Open includes queued, active and mature-open stakes. Good accounted is unended principal,
          no longer earning. Ended includes cancellations, labeled separately in each row. Current
          is open plus good accounted. T-Shares include queued/open shares and exclude
          good-accounted shares. Next maturity is the earliest open maturity on or after the indexed
          day; overdue stakes stay in Open.
        </p>
        {index && (
          <>
            <p>
              Accepted index: block {index.asOf.blockNumber} · {index.asOf.blockTimestamp} ·{' '}
              {index.finality}. Protocol {dayLabel(index.staking.contractDay)}. Ranks:{' '}
              {index.rankingDay == null ? 'unavailable' : dayLabel(index.rankingDay)} · block{' '}
              {index.rank?.asOf.blockNumber ?? 'unavailable'}.
            </p>
            <dl className="fact-rows exact-address-values">
              <div>
                <dt>Locked principal HEX</dt>
                <dd>{numberText(hex(staking?.lockedHearts))}</dd>
              </div>
              <div>
                <dt>Good-accounted HEX</dt>
                <dd>{numberText(hex(staking?.goodAccountedHearts))}</dd>
              </div>
              <div>
                <dt>Accounted T-Shares</dt>
                <dd>{numberText(shares(staking?.accountedShares))}</dd>
              </div>
            </dl>
          </>
        )}
        <h3>Live verification</h3>
        {!valid || !d?.live ? (
          <p className="notice">
            {invalidated
              ? 'Observation changed or expired. Restart to read a new pinned page.'
              : 'Current balance and stakes unavailable' +
                (d?.outcome === 'quota' ? ' — provider quota reached.' : '.')}{' '}
            Indexed facts retain their own cutoff.
          </p>
        ) : (
          <>
            <p>
              Provisional · block {page!.asOf.blockNumber} · source {page!.asOf.blockTimestamp} ·
              collected {page!.observedAt} · expires {d.live.expiresAt}.
            </p>
            <p>
              Liquid HEX: {numberText(hex(d.live.balanceHearts))}. Showing {page!.items.length} of{' '}
              {page!.stakeCount} current stakes · offset {d.live.offset}.{' '}
              {page!.enumerationComplete
                ? 'Enumeration complete at this observation.'
                : 'Partial page; whole-address stake totals and nearest maturity are not inferred.'}
            </p>
            <ul className="live-stake-rows">
              {page!.items.map((s) => (
                <li key={s.stakeId}>
                  <a href={'/stake/' + s.stakeId}>#{s.stakeId}</a>
                  <span>{compactNumber(hex(s.principalHearts), 3)} HEX</span>
                  <span>{compactNumber(shares(s.stakeShares), 3)} T-Shares</span>
                  <span>{s.unlockedDay ? 'Good accounted' : 'Current'}</span>
                </li>
              ))}
            </ul>
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
        )}
        <button onClick={restart}>Restart current observation</button>
      </details>
    </div>
  );
}
