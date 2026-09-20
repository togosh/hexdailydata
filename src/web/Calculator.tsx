import { useEffect, useState, type FormEvent } from 'react';
import { CalculatorResponseSchema } from '../contracts/reads.ts';
import { quoteStake, payoutScenario, UINT72_MAX } from '../domain/calculator.ts';
import { contractDayAt } from '../domain/day.ts';
import { parseUnits, formatUnits, displayRatio, rational } from '../domain/units.ts';
import { endpoint, useResource, useClock } from './api.ts';
import { observationState, observationLabel, dayLabel, dayDate, numberText } from './format.ts';
import { Feedback, Value, Copy } from './components.tsx';
import { Icon } from './visuals.tsx';

type Fields = { amount: string; days: string; preset: string; future: string };
function saved(): Fields {
  try {
    const f = JSON.parse(sessionStorage.getItem('calculator-fields') ?? 'null');
    if (
      f &&
      ['amount', 'days', 'preset', 'future'].every(
        (k) => typeof f[k] === 'string' && f[k].length <= 120,
      )
    )
      return f;
  } catch {}
  return { amount: '10000', days: '365', preset: '', future: '' };
}
export default function Calculator() {
  const input = useResource(endpoint('/calculator/inputs'), CalculatorResponseSchema);
  const now = useClock(),
    rate = input.data?.shareRate;
  const state = observationState(rate, now);
  const [fields, setFields] = useState(saved),
    [error, setError] = useState('');
  const [result, setResult] = useState<{
    signature: string;
    quote: ReturnType<typeof quoteStake>;
    scenario: ReturnType<typeof payoutScenario> | null;
    scenarioReason: string;
  }>();
  useEffect(() => {
    try {
      sessionStorage.setItem('calculator-fields', JSON.stringify(fields));
    } catch {}
  }, [fields]);
  const day = contractDayAt(BigInt(Math.floor(now / 1000)));
  const signature = JSON.stringify([fields, rate, input.data?.presets, day]);
  const usable = !input.loading && state !== 'unavailable' && !!rate?.value;
  const shown = usable && result?.signature === signature ? result : undefined;
  const change = (key: keyof Fields, value: string) => {
    setFields({ ...fields, [key]: value });
    setError('');
    setResult(undefined);
  };
  const calculate = (event: FormEvent) => {
    event.preventDefault();
    setResult(undefined);
    try {
      if (!usable || !rate?.value)
        throw new Error('A qualified current or last-known share rate is required.');
      if (!/^[1-9][0-9]{0,3}$/.test(fields.days))
        throw new Error('Use a whole duration from 1 through 5555 days.');
      const quote = quoteStake(
        parseUnits(fields.amount, 8, UINT72_MAX),
        Number(fields.days),
        BigInt(rate.value.rawShareRate),
        BigInt(Math.floor(now / 1000)),
      );
      let scenario: ReturnType<typeof payoutScenario> | null = null;
      let scenarioReason = '';
      if (fields.preset) {
        const preset = input.data?.presets.find((p) => String(p.window) === fields.preset);
        if (preset?.status !== 'available' || !preset.value)
          scenarioReason = 'Selected payout preset unavailable. Showing shares and maturity only.';
        else {
          const future = fields.future ? rational(parseUnits(fields.future, 36), 10n ** 36n) : null;
          scenario = payoutScenario(
            quote,
            {
              numerator: BigInt(preset.value.numerator),
              denominator: BigInt(preset.value.denominator),
            },
            future,
          );
        }
      } else if (fields.future)
        throw new Error(
          'Choose an available payout scenario before valuing its hypothetical total.',
        );
      setResult({ signature, quote, scenario, scenarioReason });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check the amount and duration.');
    }
  };
  return (
    <div className="calculator-page">
      <div className="page-heading calculator-heading">
        <div>
          <h1>Stake Calculator</h1>
          <p>Calculate T-shares and explore future value scenarios.</p>
        </div>
        <span className="calculator-context">Start today · {dayDate(day)} UTC</span>
      </div>
      <Feedback
        {...input}
        refresh={() => {
          setResult(undefined);
          input.refresh();
        }}
        hasData={!!input.data}
      />
      <form
        className="calculator-grid"
        onSubmit={calculate}
        aria-describedby="calculator-assumptions"
      >
        <section className="panel stake-inputs" aria-labelledby="stake-input-title">
          <div className="calculator-panel-heading">
            <h2 id="stake-input-title">
              <Icon name="calendar" /> Your stake
            </h2>
            <span className="calculator-tag">HEX</span>
          </div>
          <div className="calculator-panel-body">
            <div className="calculator-fields">
              <label>
                HEX amount
                <input
                  inputMode="decimal"
                  value={fields.amount}
                  maxLength={100}
                  onChange={(e) => change('amount', e.target.value)}
                  aria-describedby={error ? 'calculator-error' : 'amount-help'}
                />
              </label>
              <label>
                Stake length (days)
                <input
                  aria-label="Whole days"
                  inputMode="numeric"
                  value={fields.days}
                  maxLength={5}
                  onChange={(e) => change('days', e.target.value)}
                />
              </label>
            </div>
            <p className="meta" id="amount-help">
              Up to 8 decimals · 1–5,555 days
            </p>
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
                  <small>{days}d</small>
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
            {shown ? (
              <p className="sr-only" role="status">
                Calculated {formatUnits(shown.quote.stakeShares, 12)} T-shares; maturity{' '}
                {dayLabel(shown.quote.maturityDay)}.
              </p>
            ) : (
              <p className="calculator-hint">
                Choose your inputs, then calculate. Changes require a new calculation.
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
            <details className="calculator-details">
              <summary>Calculation details</summary>
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
                </>
              )}
            </details>
          </div>
        </section>
        <section className="panel scenario-panel" aria-labelledby="scenario-title">
          <div className="calculator-panel-heading">
            <h2 id="scenario-title">
              <Icon name="chart" /> Future Value Scenario
            </h2>
            <span className="scenario-badge">Not a prediction</span>
          </div>
          <div className="calculator-panel-body">
            <div className="future-price-row">
              <label>
                Future HEX price (USD)
                <input
                  aria-label="Hypothetical future USD per HEX"
                  inputMode="decimal"
                  value={fields.future}
                  onChange={(e) => change('future', e.target.value)}
                  placeholder="Optional, e.g. 0.01"
                  maxLength={100}
                />
              </label>
              <button className="primary" aria-label="Calculate shares & timing" disabled={!usable}>
                Calculate
              </button>
            </div>
            <details className="scenario-fields calculator-details">
              <summary>Optional payout &amp; future USD scenario</summary>
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
              <p>
                Exact mean of daily payout ratios, held constant throughout the stake. No
                compounding.
              </p>
            </details>
            <p className="calculator-hint">
              {fields.preset
                ? `${fields.preset}-day payout assumption`
                : 'Shares & maturity only. Choose a payout assumption to explore rewards.'}
            </p>
            {error && (
              <p id="calculator-error" role="alert">
                {error}
              </p>
            )}
            {shown?.scenarioReason && <p className="notice">{shown.scenarioReason}</p>}
            <section className="scenario-results" aria-labelledby="payout-result-title">
              <h3 id="payout-result-title">Hypothetical payout scenario</h3>
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
            <details className="calculator-details" id="calculator-assumptions">
              <summary>Assumptions &amp; exact results</summary>
              <p>
                Bonuses increase the shares issued, not your principal. Actual issuance depends on
                the share rate and transaction day.
              </p>
              <p>
                Historical payout means are dated observations, not forecasts. Rewards and future
                USD values are hypothetical. Early or late ending penalties are not modeled.
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
            </details>
          </div>
        </section>
      </form>
    </div>
  );
}
