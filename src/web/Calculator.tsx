import { useEffect, useState, type FormEvent } from 'react';
import { CalculatorResponseSchema } from '../contracts/reads.ts';
import { quoteStake, payoutScenario, UINT72_MAX } from '../domain/calculator.ts';
import { contractDayAt } from '../domain/day.ts';
import { parseUnits, formatUnits, displayRatio, rational } from '../domain/units.ts';
import { endpoint, useResource, useClock } from './api.ts';
import { observationState, observationLabel, dayLabel, numberText } from './format.ts';
import { Feedback, Value, Copy } from './components.tsx';

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
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Plan an ordinary new stake</p>
          <h1>Stake calculator</h1>
          <p>Exact share issuance. Clear timing. Optional hypothetical rewards.</p>
        </div>
      </div>
      <Feedback
        {...input}
        refresh={() => {
          setResult(undefined);
          input.refresh();
        }}
        hasData={!!input.data}
      />
      <div className="calculator-grid">
        <form className="panel" onSubmit={calculate} aria-describedby="calculator-assumptions">
          <h2>1. Stake amount</h2>
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
          <p className="meta" id="amount-help">
            Up to 8 decimals · no commas or exponent notation. HEX entry works without a USD price.
          </p>
          <h2>2. Stake length</h2>
          <label>
            Whole days
            <input
              inputMode="numeric"
              value={fields.days}
              maxLength={5}
              onChange={(e) => change('days', e.target.value)}
            />
          </label>
          <div className="presets">
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
          <details className="scenario-fields">
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
                    {p.status === 'available' ? `· through ${dayLabel(p.toDay!)}` : '· unavailable'}
                  </option>
                ))}
              </select>
            </label>
            {fields.preset && (
              <p className="meta">
                Exact mean of daily ratios, held constant for every staked day. No compounding.
              </p>
            )}
            <label>
              Hypothetical future USD per HEX
              <input
                inputMode="decimal"
                value={fields.future}
                onChange={(e) => change('future', e.target.value)}
                placeholder="Optional, e.g. 0.01"
                maxLength={100}
              />
            </label>
          </details>
          <button className="primary" disabled={!usable}>
            Calculate shares &amp; timing
          </button>
          {error && (
            <p id="calculator-error" role="alert">
              {error}
            </p>
          )}
        </form>
        <div>
          <section className="panel result-panel">
            <h2>Your results</h2>
            <p className="meta">
              {observationLabel(rate, now, state)}
              {rate?.asOf && <> · block {rate.asOf.blockNumber}</>}
            </p>
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
            {shown ? (
              <>
                <dl className="result-grid">
                  <div>
                    <dt>Calculated T-shares</dt>
                    <dd className="accent">
                      <Value value={formatUnits(shown.quote.stakeShares, 12)} />
                    </dd>
                  </div>
                  <div>
                    <dt>Maturity (UTC)</dt>
                    <dd>{dayLabel(shown.quote.maturityDay)}</dd>
                  </div>
                  <div>
                    <dt>Bonus hearts (share calculation only)</dt>
                    <dd>{numberText(shown.quote.bonusHearts.toString())}</dd>
                  </div>
                  <div>
                    <dt>Lock begins (UTC)</dt>
                    <dd>{dayLabel(shown.quote.lockedDay)}</dd>
                  </div>
                </dl>
                <p role="status">
                  Calculated {formatUnits(shown.quote.stakeShares, 12)} T-shares ? maturity{' '}
                  {dayLabel(shown.quote.maturityDay)}.
                </p>
                <p className="meta">
                  Raw share rate {rate?.value?.rawShareRate}. Transaction assumed on{' '}
                  {dayLabel(shown.quote.transactionDay)}. Timing invalidates at UTC midnight.
                </p>
                <Copy label="Copy exact shares" text={shown.quote.stakeShares.toString()} />
                {shown.scenarioReason && <p className="notice">{shown.scenarioReason}</p>}
                {shown.scenario && (
                  <>
                    <h3>Hypothetical payout scenario</h3>
                    <dl className="result-grid">
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
                    <p className="meta">
                      Scenario displays truncate to 8 decimal places; calculation retains the exact
                      rational.
                    </p>
                  </>
                )}
              </>
            ) : (
              <p className="empty">
                Enter an amount and duration, then calculate. Changed inputs or refreshed
                observations require a new calculation.
              </p>
            )}
          </section>
          <section className="panel" id="calculator-assumptions">
            <h2>Know the assumptions</h2>
            <p>
              Longer and larger stakes receive share bonuses under the ordinary new-stake rules.
              Bonus hearts are used to issue shares; they are not extra principal.
            </p>
            <p>
              Rewards and future USD value are hypothetical. The selected payout mean is a dated
              observation, not a forecast or guaranteed yield. Actual issuance depends on the rate
              and transaction day when a stake is created.
            </p>
            <a href="/learn">Calculation &amp; source notes ↗</a>
          </section>
        </div>
      </div>
    </>
  );
}
