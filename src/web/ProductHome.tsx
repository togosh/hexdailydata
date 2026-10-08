import type { z } from 'zod';
import {
  ProductHomeResponseSchema,
  ProductLiveResponseSchema,
} from '../contracts/product-daily.ts';
import { useResource, endpoint } from './api.ts';
import { Feedback } from './components.tsx';
import { numberText } from './format.ts';
import './product-daily.css';
import { useState } from 'react';
import ChartGraphic from './ChartGraphic.tsx';

function Reading({
  label,
  value,
  unit,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
}) {
  return (
    <div className="product-reading">
      <span>{label}</span>
      <strong title={value === null ? 'Unavailable' : String(value)}>
        {value === null ? 'Unavailable' : numberText(String(value), 8)}
      </strong>
      <small>{unit ?? ''}</small>
    </div>
  );
}
function LiveValues({ data }: { data: z.infer<typeof ProductLiveResponseSchema> }) {
  return (
    <section className="panel live-product" data-testid="live-product">
      <p className="eyebrow">Latest / live availability</p>
      <h2>Freshness is per observation</h2>
      <p className="stale-banner" role="status">
        {Object.values(data.freshness).some((f) => f.status === 'stale')
          ? 'Some saved observations are stale.'
          : Object.values(data.freshness).some((f) => f.status === 'fresh')
            ? 'Available readings retain their individual observation times.'
            : 'No current feed is qualified.'}{' '}
        Reloading reads local data only.
      </p>
      <div className="product-readings">
        <Reading label="HEX spot price" value={data.hexPriceUsd} unit="USD / HEX" />
        <Reading label="Bitcoin price" value={data.btcPriceUsd} unit="USD / BTC" />
        <Reading label="Ethereum price" value={data.ethPriceUsd} unit="USD / ETH" />
        <Reading label="PulseChain price" value={data.plsPriceUsd} unit="USD / PLS" />
        <Reading label="Suggested gas price" value={data.gasPriceWei} unit="wei / gas" />
        <Reading
          label="Tracked HEX liquidity"
          value={data.trackedLiquidityUsd}
          unit="USD estimate"
        />
      </div>
      {data.trackedSet && (
        <p>
          {data.trackedSet.poolCount} identified HEX pools · bounded tracked set, not all HEX
          liquidity. Source-derived two-sided USD estimate.
        </p>
      )}
      <div className="product-readings saved-readings">
        <Reading label="Saved holder records" value={data.savedHolderRecordCount} />
        <Reading label="Saved stake-start records" value={data.savedStakeStartRecordCount} />
        <Reading
          label="Current positive-balance population"
          value={data.positiveBalanceAddressCount}
        />
        <Reading label="Verified active stakers" value={data.activeStakerCount} />
      </div>
      <p>
        Saved records combine the accepted base with observed updates. They do not establish a
        complete population at the update block.
      </p>
      <details>
        <summary>Observation times and unavailable feeds</summary>
        <dl className="freshness-list">
          {Object.entries(data.freshness).map(([key, f]) => (
            <div key={key}>
              <dt>
                {key}: <strong>{f.status}</strong>
              </dt>
              <dd>
                {f.observedAtUtc ?? 'No qualified observation'}
                {f.baseObservedAtUtc && ` · retained base ${f.baseObservedAtUtc}`}
                {f.ageSeconds !== null && ` · age ${f.ageSeconds.toLocaleString()} seconds`}.{' '}
                {f.reason}
              </dd>
            </div>
          ))}
        </dl>
        <p>Served at {data.servedAtUtc}; this is not an observation time.</p>
      </details>
    </section>
  );
}
export function Live() {
  const resource = useResource(endpoint('/live'), ProductLiveResponseSchema);
  return (
    <div className="daily-product">
      <div className="page-heading">
        <div>
          <p className="eyebrow">HEXDailyData · Latest</p>
          <h1>Latest observations</h1>
        </div>
        <button onClick={resource.refresh}>Refresh local view</button>
      </div>
      <Feedback {...resource} />
      {resource.data && <LiveValues data={resource.data} />}
      <a href="/daily">Daily history →</a>
    </div>
  );
}
export default function Home() {
  const resource = useResource(endpoint('/home'), ProductHomeResponseSchema);
  const h = resource.data;
  const [liquidityDays, setLiquidityDays] = useState(90);
  return (
    <div className="daily-product">
      <div className="page-heading">
        <div>
          <p className="eyebrow">HEX on PulseChain</p>
          <h1>Your daily HEX overview</h1>
          <p>Daily history and latest readings, with exact values and visible gaps.</p>
        </div>
        <a className="button primary" href="/daily">
          Explore Daily
        </a>
      </div>
      <Feedback {...resource} />
      {h && (
        <>
          <section className="panel">
            <div className="daily-chart-heading">
              <div>
                <p className="eyebrow">Latest Daily · {h.daily.dateUtc}</p>
                <h2>Recorded snapshot</h2>
              </div>
              <a href="/daily">All metrics →</a>
            </div>
            <p className="meta">
              Recorded {h.daily.snapshotRecordedAtUtc ?? 'unavailable'} · historical observation,
              not a live reading or verified close.
            </p>
            <div className="product-readings">
              <Reading label="Circulating HEX" value={h.daily.circulatingHEX} unit="HEX" />
              <Reading label="Locked principal" value={h.daily.stakedHEX} unit="HEX" />
              <Reading
                label="Recorded T-share rate"
                value={h.daily.tshareRateHEX}
                unit="HEX / T-share"
              />
              <Reading
                label="Daily HEX reference price"
                value={h.daily.hexPriceUsd}
                unit="USD / HEX"
              />
            </div>
            <p>
              Reference quote recorded {h.daily.priceRecordedAtUtc ?? 'unavailable'}. Payouts use
              their own independently supported contract-day totals; later missing totals remain
              unavailable.
            </p>
          </section>
          <LiveValues data={h.live} />
          <section className="panel daily-chart">
            <div className="daily-chart-heading">
              <h2>Tracked HEX liquidity (USD estimate)</h2>
              <div>
                <button onClick={() => setLiquidityDays(30)} aria-pressed={liquidityDays === 30}>
                  30 days
                </button>{' '}
                <button onClick={() => setLiquidityDays(90)} aria-pressed={liquidityDays === 90}>
                  90 days
                </button>
              </div>
            </div>
            {h.liquidityHistory?.some((p) => p.value !== null) ? (
              <ChartGraphic
                title="Tracked HEX liquidity observations"
                points={h.liquidityHistory
                  .slice(-liquidityDays)
                  .map((p) => ({
                    key: p.dateUtc,
                    date: p.dateUtc,
                    value: p.value,
                    detail: 'USD estimate · fixed contemporary cohort · not a verified close',
                    status: p.value === null ? 'unavailable' : 'recorded',
                  }))}
              />
            ) : (
              <p>No qualified tracked-liquidity history is available.</p>
            )}
            <p className="meta">
              Fixed contemporary pool set. Daily buckets are source observations, not verified
              closes. Missing pools produce gaps; no forward filling.
            </p>
            <a href="/daily?metric=trackedLiquidityUsd">View exact daily values</a>
          </section>
          <section className="panel">
            <h2>Explore saved records</h2>
            <p>
              <a href="/search">Stake list</a> · <a href="/search?kind=holders">Holder list</a> ·{' '}
              <a href="/daily?metric=payoutPerTshareHEX">Daily payouts</a>
            </p>
            <p className="meta">{h.credits}</p>
          </section>
        </>
      )}
    </div>
  );
}
