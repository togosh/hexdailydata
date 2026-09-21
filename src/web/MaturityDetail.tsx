import { useState } from 'react';
import { MaturitiesSchema } from '../contracts/charts.ts';
import { formatUnits } from '../domain/units.ts';
import { endpoint, useResource } from './api.ts';
import { Feedback } from './components.tsx';
import { Chart } from './History.tsx';
import { dayDate } from './format.ts';
import { validRange } from './history.ts';
import type { MaturityUnit } from './charts.ts';

export default function MaturityDetail() {
  const data = useResource(endpoint('/charts/maturities'), MaturitiesSchema);
  const [unit, setUnit] = useState<MaturityUnit>(() => {
    const unit = new URLSearchParams(location.search).get('unit');
    return unit === 'T-Shares' || unit === 'Stake Count' ? unit : 'HEX';
  });
  const [selection, setSelection] = useState<{ from: string; to: string } | undefined>(() => {
    const query = new URLSearchParams(location.search),
      from = query.get('from'),
      to = query.get('to');
    return from && to && validRange(from, to, 5556) ? { from, to } : undefined;
  });
  const [error, setError] = useState('');
  const rows = (data.data?.items ?? []).filter(
    (r) => !selection || (r.date >= selection.from && r.date <= selection.to),
  );
  const points = rows.map((r) => ({
    key: String(r.day),
    date: r.date,
    value: formatUnits(
      BigInt(unit === 'HEX' ? r.principalHearts : unit === 'T-Shares' ? r.stakeShares : r.count),
      unit === 'HEX' ? 8 : unit === 'T-Shares' ? 12 : 0,
    ),
    detail: `Contract day ${r.day} / display ${r.day + 1} · ${r.count} open stakes`,
    status: 'Indexed schedule',
  }));
  return (
    <>
      <a href="/charts">← All charts</a>
      <h1>Upcoming Maturities</h1>
      <div className="panel controls">
        <label>
          Source
          <select aria-label="Source">
            <option>Native indexed stakes</option>
          </select>
        </label>
        <label>
          Metric
          <select
            aria-label="Metric"
            value={unit}
            onChange={(e) => setUnit(e.target.value as MaturityUnit)}
          >
            {['HEX', 'T-Shares', 'Stake Count'].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
        {data.data && (
          <form
            className="date-controls"
            key={data.data.cutoff.revision}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget),
                from = String(form.get('from')),
                to = String(form.get('to'));
              if (!validRange(from, to, 5556)) {
                setError('Choose an ordered interval of at most 5,556 dates.');
                return;
              }
              setError('');
              setSelection({ from, to });
            }}
          >
            <label>
              From (UTC)
              <input
                name="from"
                type="date"
                required
                defaultValue={
                  selection?.from ?? dayDate(Math.min(65535, data.data.cutoff.contractDay + 1))
                }
              />
            </label>
            <label>
              To (UTC)
              <input
                name="to"
                type="date"
                required
                defaultValue={
                  selection?.to ??
                  data.data.items.at(-1)?.date ??
                  dayDate(Math.min(65535, data.data.cutoff.contractDay + 1))
                }
              />
            </label>
            <button className="primary">Apply range</button>
          </form>
        )}
      </div>
      <Feedback {...data} />
      <p role="status">{error}</p>
      {data.data && (
        <>
          <details className="panel">
            <summary>Data details</summary>
            <p>
              Open, unsettled stakes strictly after indexed contract day{' '}
              {data.data.cutoff.contractDay}; includes queued stakes, excludes GA, ended and
              cancelled. No expected yield is included. Block {data.data.cutoff.asOf.blockNumber} ·{' '}
              {data.data.cutoff.asOf.blockTimestamp} · {data.data.cutoff.finality}.
            </p>
          </details>
          {rows.length ? (
            <section className="panel">
              <Chart points={points} title="Indexed maturity schedule" unit={unit} schedule />
            </section>
          ) : (
            <p className="notice">
              {data.data.items.length
                ? 'No maturities within this range. Other future maturities are indexed.'
                : 'No upcoming maturities at this indexed block.'}
            </p>
          )}
        </>
      )}
    </>
  );
}
