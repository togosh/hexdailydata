import {
  SavedStakeResponseSchema,
  SavedStakesResponseSchema,
  SavedAddressResponseSchema,
  type UpdatedStakeRecord,
} from '../contracts/source-update.ts';
import { ACCEPTED } from '../contracts/saved-generation.ts';
import { SourceUpdateDisclosure } from './SourceUpdateDisclosure.tsx';
import type { z } from 'zod';
import {
  SourceStakeResponseSchema,
  SourceStakesResponseSchema,
  sourceUnits,
  type SourceStakeRecord,
} from '../contracts/source-stakes.ts';
import { SourceAddressResponseSchema } from '../contracts/source-address.ts';
import { SourceHolders, SavedHolderBalance, SavedBrowseChoice } from './SourceHolders.tsx';
import { AddressSchema, StakeIdSchema } from '../contracts/reads.ts';
import { endpoint, useResource } from './api.ts';
import { SearchForm, Table, Feedback, Copy } from './components.tsx';
import { numberText } from './format.ts';
import './source-stakes.css';

const labels = {
  end_and_ga_link_present: 'End + GA links',
  end_link_present: 'End link',
  ga_link_present: 'GA link',
  no_end_or_ga_link: 'No end/GA links',
};
const selection = () => new URLSearchParams(location.search);
const navigate = (url: string) => {
  history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
};
export function sourceHref(path: string, _version?: string) {
  return path;
}
export function SourceChoice() {
  return null;
}

type Envelope = Pick<z.infer<typeof SavedStakesResponseSchema>, 'snapshot' | 'datasetVersion'> & {
  generation?: string;
};
function Disclosure({ data }: { data: Envelope }) {
  if (data.generation) return <SourceUpdateDisclosure />;
  return (
    <div className="source-disclosure">
      <p className="eyebrow">Saved subgraph · as of 5 Oct 2026</p>
      <details>
        <summary>Source and snapshot details</summary>
        <p>
          pulsechain/hex · block {data.snapshot.number.toLocaleString('en-US')} ·{' '}
          {data.snapshot.observedAtUtc}. Refresh disabled.
        </p>
        <p>
          Complete source stake-start inventory at this block. End and Good Accounting (GA) labels
          describe links supplied by the source; missing links do not establish active stakes.
          Source day labels do not establish locked or maturity days.
        </p>
        <p>
          Reported amounts use 100,000,000 hearts per HEX and 1,000,000,000,000 shares per T-share.
          Original tokens are retained in record details. There are 2,081 source-internal field
          differences across 905 records; values have not been repaired or independently verified
          on-chain.
        </p>
        <dl className="fact-rows">
          <div>
            <dt>Deployment</dt>
            <dd>{data.snapshot.deployment}</dd>
          </div>
          <div>
            <dt>Block hash</dt>
            <dd>{data.snapshot.hash}</dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>{data.datasetVersion}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function Amount({ value, unit }: { value: string; unit: 'HEX' | 'T-shares' }) {
  const exact = sourceUnits(value, unit === 'HEX' ? 8 : 12);
  return (
    <span title={exact + ' ' + unit}>
      {numberText(exact, 4)} <small>{unit}</small>
    </span>
  );
}
function SourceRows({
  items,
  version,
}: {
  items: (SourceStakeRecord | UpdatedStakeRecord)[];
  version: string;
}) {
  return (
    <>
      <div className="stake-desktop">
        <Table
          title="Saved source stake records"
          headings={[
            'Stake ID',
            'Reported owner',
            'Reported HEX',
            'Reported T-shares',
            'Source days',
            'Linked records',
          ]}
        >
          {items.map(({ reported: s, recordState }) => (
            <tr key={s.id}>
              <td>
                <a href={sourceHref('/stake/' + s.stakeId, version)}>#{s.stakeId}</a>
              </td>
              <td>
                <a
                  className="address"
                  title={s.stakerAddr}
                  href={sourceHref('/address/' + s.stakerAddr, version)}
                >
                  {s.stakerAddr.slice(0, 8)}…{s.stakerAddr.slice(-6)}
                </a>
              </td>
              <td>
                <Amount value={s.stakedHearts} unit="HEX" />
              </td>
              <td>
                <Amount value={s.stakeShares} unit="T-shares" />
              </td>
              <td>
                <small>
                  Start {s.startDay} · End {s.endDay}
                </small>
                <br />
                {s.stakedDays} days
              </td>
              <td>
                <span className="address-state">{labels[recordState]}</span>
              </td>
            </tr>
          ))}
        </Table>
      </div>
      <div className="stake-mobile">
        {items.map(({ reported: s, recordState }) => (
          <article className="stake-card" key={s.id}>
            <div>
              <a href={sourceHref('/stake/' + s.stakeId, version)}>#{s.stakeId}</a>
              <span className="address-state">{labels[recordState]}</span>
            </div>
            <div className="stake-card-values">
              <strong>
                <Amount value={s.stakedHearts} unit="HEX" />
              </strong>
              <span>
                <Amount value={s.stakeShares} unit="T-shares" />
              </span>
            </div>
            <p>
              Source days {s.startDay} → {s.endDay} · {s.stakedDays} days
            </p>
            <a className="address" href={sourceHref('/address/' + s.stakerAddr, version)}>
              {s.stakerAddr.slice(0, 8)}…{s.stakerAddr.slice(-6)}
            </a>
          </article>
        ))}
      </div>
    </>
  );
}

function SavedList({ address }: { address?: string }) {
  const q = selection(),
    cursor = q.get('cursor') ?? undefined,
    version = undefined;
  const data = useResource<
    z.infer<typeof SavedAddressResponseSchema> | z.infer<typeof SavedStakesResponseSchema>
  >(
    endpoint(address ? '/addresses/' + address + '/stakes' : '/stakes', {
      limit: 20,
      cursor,
    }),
    address ? SavedAddressResponseSchema : SavedStakesResponseSchema,
  );
  const body = data.data;
  const reset = () => navigate(sourceHref(location.pathname));
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Explore HEX on PulseChain</p>
          <h1>{address ? 'Address Lookup' : 'Stake records'}</h1>
          {address && <p className="full-address">{address}</p>}
        </div>
      </div>
      <div className="address-search">
        <SearchForm />
      </div>
      <SourceChoice />
      {!address && <SavedBrowseChoice view="stakes" />}
      {body && 'holder' in body && (
        <SavedHolderBalance holder={body.holder} liquidBalance={body.liquidBalance} />
      )}
      <section
        className="panel source-stakes"
        data-testid="source-stake-list"
        data-ready={Boolean(body)}
      >
        <h2>{address ? 'Saved stakes for this address' : 'Saved stake inventory'}</h2>
        {data.code === 'developer_access_required' ? (
          <div role="status">
            <p>Public browse limit reached. Additional records require an active API key.</p>
            <p>
              <a href="/api">Developer access</a>
            </p>
            <button onClick={reset}>Restart public pages</button>
          </div>
        ) : (
          <Feedback {...data} refresh={data.status === 409 ? reset : data.refresh} />
        )}
        {body && (
          <>
            <Disclosure data={body} />
            <p>
              {numberText(String(body.sourceStartCount))} source start records
              {address
                ? ' for this address'
                : 'generation' in body
                  ? ' in this local base-plus-updates view; complete B1 population is unproved'
                  : ' in this saved inventory'}
              . {address && 'This is not an active-stake count. Ranks are unavailable.'}
            </p>
            <SourceRows items={body.items} version={body.datasetVersion} />
            {!body.items.length && (
              <p>Not present in this saved inventory. This does not establish absence on-chain.</p>
            )}
            <div className="pager">
              <button disabled={!cursor} onClick={() => history.back()}>
                Previous page
              </button>
              <span>{body.items.length} records on this page</span>
              <button
                disabled={!body.nextCursor || data.loading}
                onClick={() => {
                  const next = new URLSearchParams({ cursor: body.nextCursor! });
                  navigate(location.pathname + '?' + next);
                }}
              >
                Next page
              </button>
            </div>
          </>
        )}
        {data.status === 409 && <button onClick={reset}>Restart saved pages</button>}
      </section>
    </>
  );
}

function SavedStake({ id }: { id: string }) {
  const data = useResource(endpoint('/stakes/' + id, {}), SavedStakeResponseSchema);
  const body = data.data,
    item = body?.item,
    s = item?.reported;
  return (
    <>
      <h1>Stake {id}</h1>
      <SearchForm />
      <SourceChoice />
      <Feedback {...data} />
      {body && (
        <section className="panel source-stakes" data-testid="source-stake-detail">
          <Disclosure data={body} />
          {!s || !item ? (
            <p>Not present in this saved inventory. This does not establish absence on-chain.</p>
          ) : (
            <>
              <h2>{labels[item.recordState]}</h2>
              <p>
                Reported owner{' '}
                <a
                  className="address"
                  href={sourceHref('/address/' + s.stakerAddr, body.datasetVersion)}
                >
                  {s.stakerAddr}
                </a>
              </p>
              <dl className="summary-grid">
                <div>
                  <dt>Reported principal</dt>
                  <dd>
                    <Amount value={s.stakedHearts} unit="HEX" />
                  </dd>
                </div>
                <div>
                  <dt>Reported shares</dt>
                  <dd>
                    <Amount value={s.stakeShares} unit="T-shares" />
                  </dd>
                </div>
                <div>
                  <dt>Reported duration</dt>
                  <dd>{s.stakedDays} days</dd>
                </div>
                <div>
                  <dt>Source day labels</dt>
                  <dd>
                    {s.startDay} → {s.endDay}
                  </dd>
                </div>
              </dl>
              <p>
                Source entity ID <code>{s.id}</code> · reported stake ID {s.stakeId}.
              </p>
              <p>
                Source timestamp {s.timestamp} seconds · source block {s.blockNumber}.
              </p>
              <p>
                End link:{' '}
                {s.stakeEnd ? 'present; source timestamp ' + s.stakeEnd.timestamp : 'not supplied'}.
                Good Accounting link:{' '}
                {s.stakeGoodAccounting
                  ? 'present; source timestamp ' + s.stakeGoodAccounting.timestamp
                  : 'not supplied'}
                .
              </p>
              {(item.discrepancies?.length ?? 0) > 0 && (
                <p className="notice">
                  {item.discrepancies?.length} source-internal field differences retained for this
                  record. See original evidence below.
                </p>
              )}
              {'observation' in item && (
                <p>
                  Record observation:{' '}
                  {item.observation.kind === 'retained_base'
                    ? 'retained from base'
                    : 'directly observed update'}{' '}
                  · {item.observation.snapshot.observedAtUtc}.
                </p>
              )}
              {'discrepancyAssessment' in item &&
                item.discrepancyAssessment === 'unassessed_after_update' && (
                  <p className="notice">
                    Updated packed-field differences are unassessed. Historical base findings are
                    retained separately in the evidence.
                  </p>
                )}
              <details className="source-record-evidence">
                <summary>Original source values and evidence</summary>
                <p>
                  Published decimal values and packed tokens are preserved separately. Decoded
                  comparisons are source-internal evidence, not replacement amounts.
                </p>
                <pre>{JSON.stringify(item, null, 2)}</pre>
              </details>
              <Copy text={s.stakeId} label="Copy stake ID" />
            </>
          )}
          <p>
            <a href={sourceHref('/search', body.datasetVersion)}>Browse saved stakes</a>
          </p>
        </section>
      )}
    </>
  );
}

export function SourceStakes({ path }: { path: string }) {
  if (path.startsWith('/address/')) {
    const address = AddressSchema.safeParse(path.slice(9));
    return address.success ? (
      <SavedList address={address.data} />
    ) : (
      <>
        <h1>Invalid address</h1>
        <SearchForm />
        <SourceChoice />
      </>
    );
  }
  if (path.startsWith('/stake/')) {
    const id = StakeIdSchema.safeParse(path.slice(7));
    return id.success ? (
      <SavedStake id={id.data} />
    ) : (
      <>
        <h1>Invalid stake ID</h1>
        <SearchForm />
        <SourceChoice />
      </>
    );
  }
  return selection().get('kind') === 'holders' ? <SourceHolders /> : <SavedList />;
}
