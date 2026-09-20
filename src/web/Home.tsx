import { lazy, Suspense, useEffect, useState, useMemo } from 'react';
import { HomeResponseSchema } from '../contracts/api.ts';
import { CalculatorResponseSchema } from '../contracts/reads.ts';
import { contractDayAt, displayDay } from '../domain/day.ts';
import { formatUnits, displayRatio } from '../domain/units.ts';
import { stakeApy } from '../domain/calculator.ts';
import { useResource, endpoint, useClock } from './api.ts';
import { Metric } from './components.tsx';
import { compactNumber, observationState, yearsFromDays, multiplyDecimals } from './format.ts';
import { Icon, type IconName } from './visuals.tsx';

const HomeChart = lazy(() => import('./History.tsx').then((m) => ({ default: m.HomeChart })));
export default function Home() {
  const home = useResource(endpoint('/home'), HomeResponseSchema, true);
  const now = useClock(),
    h = home.data;
  const snapshot = h?.current;
  // Historical scenarios load independently after Home; headlines never wait for them.
  const inputs = useResource(
    h ? endpoint('/calculator/inputs') : null,
    CalculatorResponseSchema,
    true,
  );
  const average = inputs.data?.presets.find((preset) => preset.window === 30);
  const [chart, setChart] = useState(false);
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
  const clock = new Date(now).toISOString();
  const hexDay = displayDay(contractDayAt(BigInt(Math.floor(now / 1000))));
  const totalPayout = estimate?.value ? formatUnits(BigInt(estimate.value.payoutHearts), 8) : null;
  const tvl = multiplyDecimals(
    snapshot?.stakedHex,
    ps === 'unavailable' ? null : price?.value?.usdPerHex,
  );
  const activity = snapshot?.displayDay === hexDay ? snapshot.activity : null;
  const activityRows = [
    ['New Stakes', activity?.newStakes, ''],
    ['Ended Stakes', activity?.endedStakes, ''],
    ['New Holders (net)', activity?.netHolders, ''],
    ['New Stakers (net)', activity?.netStakers, ''],
    ['NET HEX Locked', activity?.netLockedHex, 'HEX'],
    ['Payouts (est.)', es === 'unavailable' ? null : totalPayout, 'HEX'],
    ['Penalties', activity?.penaltiesHex, 'HEX'],
  ] as const;
  const apys = useMemo(() => {
    if (
      rs === 'unavailable' ||
      !rate?.value ||
      inputs.error ||
      average?.status !== 'available' ||
      !average.value ||
      average.count !== 30 ||
      average.toDay == null ||
      average.fromDay !== average.toDay - 29 ||
      average.toDay >= hexDay - 1
    )
      return null;
    try {
      const daily = {
        numerator: BigInt(average.value.numerator),
        denominator: BigInt(average.value.denominator),
      };
      return ([1, 5, 10] as const).map((years) => {
        const result = stakeApy(
          10000n * 100000000n,
          years,
          BigInt(rate.value.rawShareRate),
          daily,
          BigInt(Math.floor(now / 86400000) * 86400),
        );
        return daily.numerator > 0n && result.numerator * 100n < result.denominator
          ? '<0.01'
          : compactNumber(displayRatio(result), 2, false);
      });
    } catch {
      return null;
    }
  }, [rate?.value, average, inputs.error, rs, hexDay]);
  const ready = !!(
    snapshot?.stakedPercent != null &&
    snapshot.holderCount != null &&
    snapshot.stakerCount != null &&
    rs !== 'unavailable' &&
    ps !== 'unavailable' &&
    cs !== 'unavailable'
  );
  const facts = [
    ['Circulating supply', snapshot?.circulatingHex, 'HEX'],
    ['Locked principal (incl. GA)', snapshot?.stakedHex, 'HEX'],
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
      <dl className="home-metrics" data-testid="headlines" data-ready={ready}>
        <Metric
          id="price"
          icon="price"
          title="HEX Price"
          value={ps === 'unavailable' ? null : price?.value?.usdPerHex}
          prefix="$"
          display={compactNumber(price?.value?.usdPerHex, 7)}
        />
        <Metric
          id="completed"
          icon="chart"
          title="Payout per T-share"
          value={cs === 'unavailable' ? null : completed?.value?.hexPerTShare}
          unit="HEX"
          display={compactNumber(completed?.value?.hexPerTShare, 3)}
        />
        <Metric
          id="rate"
          icon="database"
          title="T-share Rate"
          value={rs === 'unavailable' ? null : rate?.value?.hexPerTShareBeforeBonuses}
          unit="HEX"
          display={compactNumber(rate?.value?.hexPerTShareBeforeBonuses, 1, false)}
        />
        <Metric
          id="staked"
          icon="pie"
          title="% Staked"
          value={snapshot?.stakedPercent}
          unit="%"
          display={compactNumber(snapshot?.stakedPercent, 2, false)}
        />
        <Metric
          id="holders"
          icon="person"
          title="All Holders"
          value={snapshot?.holderCount}
          display={compactNumber(snapshot?.holderCount, 0, false)}
        />
        <Metric
          id="stakers"
          icon="people"
          title="All Stakers"
          value={snapshot?.stakerCount}
          display={compactNumber(snapshot?.stakerCount, 0, false)}
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
            <dl className="fact-rows">
              {facts.map(([label, value, unit]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd title={value ?? 'Unavailable'}>
                    {compactNumber(value, unit ? 2 : 0, !!unit)}
                    {value != null && unit && <small> {unit}</small>}
                  </dd>
                </div>
              ))}
              <div data-metric="tvl">
                <dt>TVL Staked</dt>
                <dd title={tvl == null ? 'Unavailable' : tvl + ' USD'}>
                  {tvl == null ? 'Unavailable' : '$' + compactNumber(tvl, 2)}
                </dd>
              </div>
              <div data-metric="duration">
                <dt>Avg Stake Length</dt>
                <dd title={yearsFromDays(snapshot?.weightedStakeLengthDays) ?? 'Unavailable'}>
                  {compactNumber(yearsFromDays(snapshot?.weightedStakeLengthDays), 2, false)}
                  {snapshot?.weightedStakeLengthDays != null && <small> years</small>}
                </dd>
              </div>
            </dl>
          </section>
          <section className="panel home-today">
            <div className="home-panel-heading">
              <h2>
                <Icon name="calendar" />
                Today in HEX
              </h2>
            </div>
            <dl className="fact-rows">
              {activityRows.map(([label, value, unit]) => (
                <div
                  key={label}
                  data-metric={label === 'Payouts (est.)' ? 'total-estimate' : undefined}
                >
                  <dt>{label}</dt>
                  <dd title={value ?? 'Unavailable'}>
                    {compactNumber(value, unit ? 2 : 0, !!unit)}
                    {value != null && unit && <small> {unit}</small>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <section className="panel home-apy" data-testid="stake-apy" data-ready={apys !== null}>
          <div className="home-panel-heading">
            <h2>
              <Icon name="pie" />
              Stake APY
            </h2>
          </div>
          <dl className="fact-rows">
            {[1, 5, 10].map((years, i) => (
              <div key={years}>
                <dt>{years}Y</dt>
                <dd>{apys ? apys[i] + '%' : 'Unavailable'}</dd>
              </div>
            ))}
          </dl>
        </section>
        <div className="home-chart-slot">
          {chart && (
            <Suspense fallback={<p>Loading chart controls…</p>}>
              <HomeChart date={h?.daily?.dateUtc ?? null} />
            </Suspense>
          )}
        </div>
      </div>
      <div className="home-market-row">
        <section className="panel home-gas" aria-labelledby="home-gas-title">
          <div className="home-panel-heading">
            <h2 id="home-gas-title">
              <Icon name="link" />
              PulseChain Gas
            </h2>
          </div>
          <dl className="gas-quote">
            <dt>Gas price</dt>
            <dd title="Gas price feed is not connected">Unavailable</dd>
          </dl>
        </section>
        <section className="panel home-markets" aria-labelledby="home-markets-title">
          <div className="home-panel-heading">
            <h2 id="home-markets-title">
              <Icon name="chart" />
              Market Prices
            </h2>
          </div>
          <dl className="market-quotes">
            {['BTC', 'ETH', 'PLS', 'PLSX', 'INC', 'PRVX'].map((symbol) => (
              <div key={symbol}>
                <dt>{symbol}</dt>
                <dd title="Market price feed is not connected">Unavailable</dd>
              </div>
            ))}
          </dl>
        </section>
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
    </div>
  );
}
