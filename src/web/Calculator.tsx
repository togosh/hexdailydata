import { useEffect, useState, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { HomeResponseSchema } from '../contracts/api.ts';
import { CalculatorResponseSchema } from '../contracts/reads.ts';
import { quoteStake, payoutScenario } from '../domain/calculator.ts';
import { contractDayAt } from '../domain/day.ts';
import { parseUnits, formatUnits, displayRatio, rational } from '../domain/units.ts';
import { endpoint, useResource, useClock } from './api.ts';
import { observationState, observationLabel, dayLabel, dayDate, numberText } from './format.ts';
import { Value, Copy } from './components.tsx';
import { Icon } from './visuals.tsx';
import {
  AMOUNT_LIMIT,
  AMOUNT_SESSION_KEY,
  readAmountFields,
  usdCents,
  usdToHearts,
  hexHearts,
  currentUsdEquivalent,
  qualifiedAmountPrice,
  formatAmount,
  ungroupAmount,
  type AmountFields,
} from './calculator-amount.ts';
import './calculator-amount.css';

function AmountInput({
  value,
  onValue,
  minimumDecimals = 0,
  ...props
}: Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'onFocus' | 'onBlur'> & {
  value: string;
  onValue: (value: string) => void;
  minimumDecimals?: 0 | 2;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <input
      {...props}
      // Room for grouping plus an invalid over-limit edit; never truncate a grouped
      // paste into a different valid principal. Canonical limits are validated below.
      maxLength={props.maxLength ? Math.ceil((props.maxLength * 4) / 3) + 4 : undefined}
      value={editing ? value : formatAmount(value, minimumDecimals)}
      onFocus={(event) => {
        const target = event.currentTarget;
        flushSync(() => setEditing(true));
        // Focus starts a fresh edit; select after the canonical value is committed.
        target.select();
      }}
      onBlur={() => setEditing(false)}
      onChange={(event) => onValue(ungroupAmount(event.target.value))}
    />
  );
}

function saved(): AmountFields {
  try {
    return readAmountFields(sessionStorage.getItem(AMOUNT_SESSION_KEY));
  } catch {}
  return readAmountFields(null);
}
export default function Calculator() {
  const input = useResource(endpoint('/calculator/inputs'), CalculatorResponseSchema, true);
  const market = useResource(endpoint('/home'), HomeResponseSchema, true);
  const now = useClock(),
    rate = input.data?.shareRate;
  const state = observationState(rate, now);
  const [fields, setFields] = useState(saved),
    [error, setError] = useState<{ signature: string; message: string }>();
  const [result, setResult] = useState<{
    signature: string;
    quote: ReturnType<typeof quoteStake>;
    scenario: ReturnType<typeof payoutScenario> | null;
    scenarioReason: string;
  }>();
  useEffect(() => {
    try {
      sessionStorage.setItem(AMOUNT_SESSION_KEY, JSON.stringify(fields));
    } catch {}
  }, [fields]);
  const day = contractDayAt(BigInt(Math.floor(now / 1000)));
  const price = market.data?.live.price;
  const priceState = observationState(price, now);
  const amountPrice = qualifiedAmountPrice(market.data, now, market.error);
  let principal: bigint | undefined;
  let amountError = '';
  try {
    if (fields.unit === 'HEX') principal = hexHearts(fields.hex);
    else {
      usdCents(fields.usd);
      if (amountPrice) principal = usdToHearts(fields.usd, amountPrice.value.usdPerHex);
    }
  } catch (e) {
    amountError = e instanceof Error ? e.message : 'Check the amount.';
  }
  const priceReason =
    fields.unit === 'USD' && !amountPrice
      ? market.loading && !market.error && !market.data
        ? 'Loading current HEX price…'
        : 'Current HEX price unavailable — enter HEX instead.'
      : '';
  const future =
    fields.futureMode === 'current'
      ? priceState === 'fresh'
        ? (price?.value?.usdPerHex ?? '')
        : ''
      : fields.future;
  const signature = JSON.stringify([
    fields,
    future,
    rate,
    input.data?.presets,
    day,
    fields.unit === 'USD' ? amountPrice : null,
  ]);
  const usable = !input.loading && state !== 'unavailable' && !!rate?.value;
  const currentError = error?.signature === signature ? error.message : '';
  const visibleError = amountError || priceReason || currentError;
  const shown =
    usable && principal !== undefined && result?.signature === signature ? result : undefined;
  const change = <K extends keyof AmountFields>(key: K, value: AmountFields[K]) => {
    setFields({
      ...fields,
      [key]: value,
      ...(key === 'future' ? { futureMode: 'custom' as const } : {}),
    });
  };
  // Hide old results immediately via the signature; debounce local arithmetic only.
  // The signature contains every quote/scenario input, including the UTC contract day.
  useEffect(() => {
    setResult(undefined);
    setError(undefined);
    if (!usable || principal === undefined || !rate?.value) return;
    const timer = setTimeout(() => {
      try {
        if (!/^[1-9][0-9]{0,3}$/.test(fields.days))
          throw new Error('Use a whole duration from 1 through 5555 days.');
        const quote = quoteStake(
          principal,
          Number(fields.days),
          BigInt(rate.value.rawShareRate),
          BigInt(Math.floor(now / 1000)),
        );
        let scenario: ReturnType<typeof payoutScenario> | null = null;
        let scenarioReason = '';
        if (fields.preset) {
          const preset = input.data?.presets.find((p) => String(p.window) === fields.preset);
          if (preset?.status !== 'available' || !preset.value)
            scenarioReason =
              'Selected payout preset unavailable. Showing shares and maturity only.';
          else {
            const futurePrice = future ? rational(parseUnits(future, 36), 10n ** 36n) : null;
            scenario = payoutScenario(
              quote,
              {
                numerator: BigInt(preset.value.numerator),
                denominator: BigInt(preset.value.denominator),
              },
              futurePrice,
            );
          }
        } else if (future && fields.futureMode !== 'current')
          throw new Error(
            'Choose an available payout scenario before valuing its hypothetical total.',
          );
        setResult({ signature, quote, scenario, scenarioReason });
        setError(undefined);
      } catch (e) {
        setError({
          signature,
          message: e instanceof Error ? e.message : 'Check the amount and duration.',
        });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [signature, usable]);
  return (
    <div className="calculator-page">
      <div className="page-heading calculator-heading">
        <h1>Stake Calculator</h1>
      </div>
      <form
        className="calculator-grid"
        onSubmit={(event) => event.preventDefault()}
        aria-describedby="calculator-assumptions"
      >
        <section className="panel stake-inputs" aria-labelledby="stake-input-title">
          <div className="calculator-panel-heading">
            <h2 id="stake-input-title">
              <Icon name="calendar" /> Your stake
            </h2>
            <div className="amount-unit-toggle" role="group" aria-label="Stake amount unit">
              {(['USD', 'HEX'] as const).map((unit) => (
                <button
                  type="button"
                  key={unit}
                  aria-pressed={fields.unit === unit}
                  onClick={() => change('unit', unit)}
                >
                  {unit}
                </button>
              ))}
            </div>
          </div>
          <div className="calculator-panel-body">
            <div className="calculator-fields">
              <label>
                {fields.unit} amount
                <AmountInput
                  aria-label={`${fields.unit} amount`}
                  inputMode="decimal"
                  value={fields.unit === 'USD' ? fields.usd : fields.hex}
                  maxLength={AMOUNT_LIMIT}
                  minimumDecimals={2}
                  onValue={(value) => change(fields.unit === 'USD' ? 'usd' : 'hex', value)}
                  aria-invalid={!!amountError}
                  aria-describedby={
                    visibleError
                      ? 'calculator-error calculator-amount-help'
                      : 'calculator-amount-help'
                  }
                />
              </label>
              <label>
                Stake length (days)
                <AmountInput
                  aria-label="Whole days"
                  inputMode="numeric"
                  value={fields.days}
                  maxLength={5}
                  onValue={(value) => change('days', value)}
                />
              </label>
            </div>
            <div className="calculator-amount-help" id="calculator-amount-help" aria-live="polite">
              {principal !== undefined && amountPrice && (
                <>
                  <p data-testid="amount-equivalent">
                    {fields.unit === 'USD'
                      ? `Estimated HEX: ${formatAmount(formatUnits(principal, 8), 2)}`
                      : `Estimated USD: $${formatAmount(currentUsdEquivalent(principal, amountPrice.value.usdPerHex), 2)}`}
                  </p>
                </>
              )}
              {fields.unit === 'HEX' && !amountPrice && (
                <p className="meta">
                  Current USD equivalent unavailable. HEX calculations do not need a market price.
                </p>
              )}
            </div>
            {visibleError && (
              <p className="calculator-amount-error" id="calculator-error" role="alert">
                {visibleError}
              </p>
            )}
            {(!usable || state === 'stale') && (
              <p className="calculator-hint" role="status">
                {input.loading
                  ? 'Loading share rate…'
                  : state === 'stale'
                    ? 'Last-known-rate scenario. The current contract rate is not confirmed.'
                    : 'Share rate unavailable or expired. A qualified current or last-known rate is required.'}
              </p>
            )}
            <div className="presets" role="group" aria-label="Stake length quick select">
              {[
                [365, '1Y'],
                [1825, '5Y'],
                [3650, '10Y'],
                [5475, '15Y'],
                [5555, 'MAX'],
              ].map(([days, name]) => (
                <button
                  type="button"
                  key={days}
                  aria-pressed={fields.days === String(days)}
                  onClick={() => change('days', String(days))}
                >
                  {name}
                </button>
              ))}
            </div>
            <dl className="calculator-quote">
              <div className="share-result">
                <dt>Calculated T-shares</dt>
                <dd>
                  {shown ? (
                    <Value value={formatUnits(shown.quote.stakeShares, 12)} places={4} />
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt>Maturity date (UTC)</dt>
                <dd>{shown ? dayDate(shown.quote.maturityDay) : '—'}</dd>
              </div>
            </dl>
          </div>
        </section>
        <section className="panel scenario-panel" aria-labelledby="scenario-title">
          <div className="calculator-panel-heading">
            <h2 id="scenario-title">
              <Icon name="chart" /> Future Value Scenario
            </h2>
          </div>
          <div className="calculator-panel-body">
            <section className="scenario-results" aria-labelledby="payout-result-title">
              <h3 className="sr-only" id="payout-result-title">
                Hypothetical payout scenario
              </h3>
              <dl className="calculator-quote scenario-values">
                <div>
                  <dt>Principal + rewards (HEX)</dt>
                  <dd>
                    {shown?.scenario ? (
                      <Value value={displayRatio(shown.scenario.totalHex, 8)} places={3} />
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div className="usd-result">
                  <dt>Future USD value</dt>
                  <dd>
                    {shown?.scenario?.usd ? (
                      <Value value={displayRatio(shown.scenario.usd, 8)} places={2} prefix="$" />
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
              </dl>
              <p className="calculator-hint">
                Rewards:{' '}
                {shown?.scenario ? (
                  <Value value={displayRatio(shown.scenario.rewardHex, 8)} places={3} unit="HEX" />
                ) : (
                  '—'
                )}
              </p>
            </section>
            <div className="future-price-row">
              <label>
                Future HEX price (USD)
                <input
                  aria-label="Hypothetical future USD per HEX"
                  inputMode="decimal"
                  value={future}
                  onChange={(e) => change('future', e.target.value)}
                  placeholder="Enter a USD price"
                  maxLength={100}
                />
              </label>
            </div>
          </div>
        </section>
        {shown && (
          <p className="sr-only" role="status">
            Calculated {formatUnits(shown.quote.stakeShares, 12)} T-shares; maturity{' '}
            {dayLabel(shown.quote.maturityDay)}.
          </p>
        )}
        <details className="calculator-notes" id="calculator-assumptions">
          <summary>
            Details &amp; assumptions
            {currentError
              ? ' - Check inputs'
              : input.error || state === 'unavailable'
                ? ' - Data unavailable'
                : state === 'stale'
                  ? ' - Last-known rate'
                  : ''}
          </summary>
          <div className="calculator-notes-body">
            <p>
              Spot estimate; fees and slippage excluded.
              {price?.value?.valuation === 'peg_assumed' && ' USD peg assumed.'}
            </p>
            <p>USD and HEX keep separate drafts. Switching units recalls that unit’s amount.</p>
            <p>
              USD-to-HEX conversion rounds down to eight decimals (one heart). The current-price
              amount conversion is separate from the hypothetical future price.
            </p>
            {price?.value && (
              <p className="calculator-price-source">
                Current price observation ({priceState}): ${price.value.usdPerHex} / HEX. Observed
                at {price.observedAt}; source block {price.asOf.blockNumber} at{' '}
                {price.asOf.blockTimestamp}. Method: {price.method}; finality: {price.finality};
                valuation: {price.value.valuation}.
                {market.error &&
                  ' Latest price fetch failed; this retained observation cannot convert USD.'}
              </p>
            )}
            <p role="status">{input.error ?? (input.loading ? 'Loading...' : '')}</p>
            {fields.futureMode === 'current' && (
              <p className="calculator-hint">
                {future
                  ? 'Future price defaults to the current HEX price.'
                  : 'Current HEX price unavailable. Enter a future price to calculate USD value.'}
              </p>
            )}
            {state === 'stale' && (
              <p className="notice">
                Last-known-rate scenario. The current contract rate is not confirmed.
              </p>
            )}
            {state === 'unavailable' && (
              <p className="notice">
                Share rate unavailable or expired. Your inputs are preserved; refresh when a
                qualified observation is available.
              </p>
            )}
            <div className="calculator-details">
              <h3>Calculation details</h3>
              <p className="meta">
                {observationLabel(rate, now, state)}
                {rate?.asOf && <> · block {rate.asOf.blockNumber}</>}
              </p>
              <p>
                New stakes lock the next contract day. Maturity does not end or pay a stake
                automatically.
              </p>
              {shown && (
                <>
                  <dl className="fact-rows calculator-exact">
                    <div>
                      <dt>Principal (HEX)</dt>
                      <dd data-testid="exact-principal-hex">
                        {formatUnits(shown.quote.principalHearts, 8)}
                      </dd>
                    </div>
                    <div>
                      <dt>Principal hearts</dt>
                      <dd data-testid="exact-principal-hearts">
                        {shown.quote.principalHearts.toString()}
                      </dd>
                    </div>
                    <div>
                      <dt>Exact T-shares</dt>
                      <dd>{formatUnits(shown.quote.stakeShares, 12)}</dd>
                    </div>
                    <div>
                      <dt>Lock begins (UTC)</dt>
                      <dd>{dayLabel(shown.quote.lockedDay)}</dd>
                    </div>
                    <div>
                      <dt>Bonus hearts (shares only)</dt>
                      <dd>{numberText(shown.quote.bonusHearts.toString())}</dd>
                    </div>
                  </dl>
                  <p className="meta">
                    Raw share rate {rate?.value?.rawShareRate}. Transaction assumed on{' '}
                    {dayLabel(shown.quote.transactionDay)}. Timing invalidates at UTC midnight.
                  </p>
                  <Copy label="Copy exact shares" text={shown.quote.stakeShares.toString()} />
                  <Copy
                    label="Copy principal hearts"
                    text={shown.quote.principalHearts.toString()}
                  />
                </>
              )}
            </div>
            <div className="scenario-fields calculator-details">
              <label>
                Constant daily payout assumption
                <select
                  aria-label="Constant daily payout assumption"
                  value={fields.preset}
                  onChange={(e) => change('preset', e.target.value)}
                >
                  <option value="">Shares &amp; maturity only</option>
                  {input.data?.presets.map((p) => (
                    <option key={p.window} value={p.window} disabled={p.status !== 'available'}>
                      {p.window}-day mean{' '}
                      {p.status === 'available'
                        ? `· through ${dayLabel(p.toDay!)}`
                        : '· unavailable'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="calculator-hint">
              {fields.preset
                ? `${fields.preset}-day payout assumption`
                : 'Shares & maturity only. Choose a payout assumption to explore rewards.'}
            </p>
            {shown?.scenarioReason && <p className="notice">{shown.scenarioReason}</p>}
            <div className="calculator-details">
              <h3>Scenario details</h3>
              <p>
                Bonuses increase shares, not principal. Historical payout averages are held constant
                without compounding; rewards and future USD values are hypothetical. Early or late
                ending penalties are not modeled.
              </p>
              {shown?.scenario && (
                <dl className="fact-rows calculator-exact">
                  <div>
                    <dt>Rewards (HEX)</dt>
                    <dd>{numberText(displayRatio(shown.scenario.rewardHex, 8))}</dd>
                  </div>
                  <div>
                    <dt>Principal + rewards (HEX)</dt>
                    <dd>{numberText(displayRatio(shown.scenario.totalHex, 8))}</dd>
                  </div>
                  {shown.scenario.usd && (
                    <div>
                      <dt>Future USD value</dt>
                      <dd>${numberText(displayRatio(shown.scenario.usd, 8))}</dd>
                    </div>
                  )}
                </dl>
              )}
              <p>
                Scenario details truncate to 8 decimals; calculations retain exact ratios. Blank
                future price means no USD result; zero is valid.
              </p>
              <a href="/learn">Calculation &amp; source notes ↗</a>
            </div>
          </div>
        </details>
      </form>
    </div>
  );
}
