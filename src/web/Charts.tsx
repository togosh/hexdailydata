import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArchiveChartsSchema,
  NativeChartsSchema,
  MaturitiesSchema,
  type ArchiveCharts,
  type NativeCharts,
} from '../contracts/charts.ts';
import { endpoint, useResource } from './api.ts';
import { compactNumber, dayDate } from './format.ts';
import { Icon, type IconName } from './visuals.tsx';
import ChartGraphic from './ChartGraphic.tsx';
import {
  categories,
  chartDefinitions,
  seriesFor,
  detailHref,
  maturitySeries,
  chartNumber,
  type Category,
  type ChartDefinition,
  type ChartRange,
  type MaturityUnit,
} from './charts.ts';
import './charts.css';

function LazySection({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={ready ? '' : 'charts-deferred'} data-lazy-ready={ready}>
      {ready ? children : <p className="meta">Charts load as you scroll.</p>}
    </div>
  );
}
function RangeButtons<T extends string>({
  values,
  selected,
  onChange,
  label,
}: {
  values: readonly T[];
  selected: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="chart-presets" role="group" aria-label={label}>
      {values.map((value) => (
        <button key={value} aria-pressed={selected === value} onClick={() => onChange(value)}>
          {value}
        </button>
      ))}
    </div>
  );
}
function HistoryCard({
  def,
  archive,
  native,
  loading,
}: {
  def: ChartDefinition;
  archive: ArchiveCharts | undefined;
  native: NativeCharts | undefined;
  loading: boolean;
}) {
  const [range, setRange] = useState<ChartRange>('ALL');
  const series = seriesFor(def, archive, native, range);
  const latest = series.points.findLast((p) => p.value !== null);
  const second = series.secondary.find((p) => p.key === latest?.key);
  const href = detailHref(def, series);
  const span =
    series.points.length > 1
      ? (Date.parse(series.points.at(-1)!.date) - Date.parse(series.points[0]!.date)) / 86400000
      : 0;
  const full = seriesFor(def, archive, native, 'ALL');
  const fullSpan =
    full.start && full.end ? (Date.parse(full.end) - Date.parse(full.start)) / 86400000 : 0;
  const provenance = latest
    ? `${series.source === 'native' ? 'Native completed-day' : def.id === 'cost' ? 'Derived · HDS' : 'HDS reported'} · through ${latest.date}${series.partial || series.truncated ? ' · partial' : series.gaps ? ' · gaps' : ''}`
    : loading
      ? 'Loading available history…'
      : 'Unavailable · no supported history';
  return (
    <article
      className="chart-card"
      data-chart={def.id}
      data-source={series.source}
      data-ready={!!latest}
    >
      <div className="chart-card-heading">
        <h3>
          <a href={href}>{def.title}</a>
        </h3>
        <a className="chart-open" href={href} aria-label={`Explore ${def.title}`}>
          ↗
        </a>
      </div>
      <div className="chart-value" data-testid="chart-value">
        {latest
          ? `${def.id === 'price' || def.id === 'cost' ? '$' : ''}${chartNumber(latest.value, def.id === 'price' ? 6 : 2)}`
          : loading
            ? 'Loading…'
            : 'Unavailable'}
      </div>
      <div className="chart-unit">
        {def.unit}
        {def.id === 'price' && ' · reference price'}
      </div>
      <p className="chart-provenance">{provenance}</p>
      {latest && fullSpan >= 30 && (
        <RangeButtons
          values={fullSpan >= 365 ? (['30D', '1Y', 'ALL'] as const) : (['30D', 'ALL'] as const)}
          selected={range}
          onChange={setRange}
          label={`${def.title} range`}
        />
      )}
      {latest ? (
        <a className="chart-visual-link" href={href} aria-label={`Open exact ${def.title} history`}>
          <ChartGraphic
            points={series.points}
            secondary={def.paired ? series.secondary : []}
            title={`${def.title}, ${def.unit}. Missing dates and values break lines.`}
            bars={!!def.bars}
          />
        </a>
      ) : (
        <div className="chart-empty">
          <Icon name="chart" />
          <p>
            {loading
              ? 'Reading retained data'
              : def.id === 'activity'
                ? 'Native completed-day activity is not available.'
                : 'No values from an accepted source.'}
          </p>
          <a href={href}>Open data explorer →</a>
        </div>
      )}
      <div className="chart-card-foot">
        {def.secondaryLabel ? (
          <>
            <span className="legend-primary">
              {def.id === 'supply'
                ? 'Circulating'
                : def.id === 'activity'
                  ? 'New'
                  : 'Locked principal'}
            </span>
            <span className={def.paired ? 'legend-secondary' : ''}>
              {def.secondaryLabel}: {compactNumber(second?.value)}
              {def.id === 'staked' && second?.value != null ? '%' : ''}
            </span>
          </>
        ) : (
          <span>
            {def.id === 'cost'
              ? 'HDS share rate × HDS reference price'
              : def.id === 'duration'
                ? 'Principal-weighted original duration'
                : span
                  ? 'Exact values & source details ↗'
                  : 'Exact records & source details ↗'}
          </span>
        )}
      </div>
    </article>
  );
}
export function MaturityCard() {
  const data = useResource(endpoint('/charts/maturities'), MaturitiesSchema);
  const [range, setRange] = useState('90D');
  const [unit, setUnit] = useState<MaturityUnit>('HEX');
  const series = data.data
    ? maturitySeries(
        data.data,
        ({ '90D': 90, '1Y': 365, '3Y': 1095, ALL: 0 } as Record<string, number>)[range]!,
        unit,
      )
    : null;
  const maturityParams = new URLSearchParams({ unit });
  if (data.data) {
    const days = ({ '90D': 90, '1Y': 365, '3Y': 1095, ALL: 0 } as Record<string, number>)[range]!;
    const from = Math.min(65535, data.data.cutoff.contractDay + 1);
    maturityParams.set('from', dayDate(from));
    maturityParams.set(
      'to',
      dayDate(
        Math.min(
          65535,
          days ? data.data.cutoff.contractDay + days : (data.data.items.at(-1)?.day ?? from),
        ),
      ),
    );
  }
  const href = '/charts/maturities?' + maturityParams;
  return (
    <article className="chart-card maturity-card" data-chart="maturities" data-ready={!!data.data}>
      <div className="chart-card-heading">
        <h3>
          <a href={href}>Upcoming Maturities</a>
        </h3>
        <a className="chart-open" href={href} aria-label="Explore Upcoming Maturities">
          ↗
        </a>
      </div>
      <div className="chart-value">
        {series ? compactNumber(series.total) : data.loading ? 'Loading…' : 'Unavailable'}
      </div>
      <div className="chart-unit">{unit} · future scheduled principal / shares</div>
      <p className="chart-provenance">
        {data.data
          ? `Indexed · ${data.data.cutoff.asOf.blockTimestamp.slice(0, 10)} · ${data.data.cutoff.finality}`
          : data.loading
            ? 'Loading native index…'
            : 'Unavailable · native maturity index'}
      </p>
      {series ? (
        <>
          <RangeButtons
            values={['HEX', 'T-Shares', 'Stake Count'] as const}
            selected={unit}
            onChange={setUnit}
            label="Maturity unit"
          />
          <RangeButtons
            values={['90D', '1Y', '3Y', 'ALL']}
            selected={range}
            onChange={setRange}
            label="Maturity range"
          />
          {series.count !== '0' ? (
            <a className="chart-visual-link" href={href} aria-label="Open exact maturity schedule">
              <ChartGraphic
                points={series.points}
                title={`Upcoming Maturities in ${unit}; ${series.width}-day buckets`}
                bars
              />
            </a>
          ) : (
            <div className="chart-empty">
              <Icon name="calendar" />
              <p>
                {series.beyond
                  ? 'No maturities in this range. Later maturities are indexed.'
                  : 'No upcoming maturities at this indexed block.'}
              </p>
            </div>
          )}
          <div className="chart-card-foot">
            {compactNumber(series.count)} stakes · {series.width}-day buckets · open stakes only
          </div>
        </>
      ) : (
        <div className="chart-empty">
          <Icon name="calendar" />
          <p>Available when native stakes are indexed.</p>
          {!data.loading && <button onClick={data.refresh}>Retry maturity data</button>}
          <a href={href}>Open maturity details →</a>
        </div>
      )}
      {data.error && data.data && (
        <p role="status" className="meta">
          Refresh failed; showing the prior indexed block.{' '}
          <button onClick={data.refresh}>Retry</button>
        </p>
      )}
    </article>
  );
}
const sections: [string, IconName, string][] = [
  ['Featured', 'chart', 'Price and staking rewards'],
  ['Staking', 'database', 'Participation and scheduled maturities'],
  ['Supply', 'pie', 'Supply composition and share cost'],
  ['Activity', 'chart', 'Completed-day protocol activity'],
  ['Adoption', 'people', 'The current holder population'],
];
export default function Charts() {
  const [category, setCategory] = useState<Category>('All');
  const archive = useResource(endpoint('/charts/archive'), ArchiveChartsSchema);
  const native = useResource(endpoint('/charts/native'), NativeChartsSchema);
  const loading = archive.loading || native.loading;
  return (
    <div className="charts-dashboard">
      <div className="charts-heading">
        <div>
          <h1>Charts</h1>
          <p>HEX price, staking, supply and protocol activity.</p>
        </div>
        <span className="charts-chain">PulseChain HEX</span>
      </div>
      <nav className="chart-categories" aria-label="Chart categories">
        {categories.map((c) => (
          <button key={c} aria-pressed={c === category} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </nav>
      <details className="charts-data-details">
        <summary>Data details</summary>
        <p>
          Each chart uses one source for its selected range. Complete native daily series are
          preferred; retained HDS history is the reported fallback. ALL shows retained history, not
          a claim of genesis coverage. Gaps remain gaps. Headline values are the latest supported
          point in the selected range.
        </p>
        <p>
          HDS dates are source-record dates, not proven market closes. Prices are PulseChain
          reference prices only. T-Share cost multiplies the same HDS record’s admitted price and
          share rate exactly. No live price is used here.
        </p>
        <p>
          Locked principal includes good-accounted (GA) stakes. Native stakers and weighted original
          duration use accounted principal (exclude GA-only); HDS retains its reported definitions.
          Native holders are positive-liquid addresses. Total T-Shares is the HDS reported series,
          not a native ledger denominator. Activity counts are native starts/ends; penalties are
          capped native event penalties or explicitly HDS reported.
        </p>
        <p>
          Maturities show unsettled stakes strictly after the indexed protocol day, including queued
          stakes; GA, ended and cancelled stakes are excluded. This is a schedule at the labeled
          block, not a payout forecast.
        </p>
        <p>
          {archive.data
            ? `HDS revision ${archive.data.revision}; acquired ${archive.data.metadata.selection.provenance.acquiredAt}. ${archive.data.metadata.selection.provenance.statement}`
            : 'HDS archive unavailable.'}
        </p>
        <p>
          {native.data
            ? `Native cutoff: block ${native.data.cutoff.asOf.blockNumber}, ${native.data.cutoff.asOf.blockTimestamp}, ${native.data.cutoff.finality}. ${native.data.truncated ? 'Limited to the latest 10,000 retained days.' : ''}`
            : 'Native daily index unavailable.'}
        </p>
        <p>
          {archive.error && 'Archive request unavailable. '}
          {native.error && 'Native request unavailable. '}
        </p>
        <button
          onClick={() => {
            archive.refresh();
            native.refresh();
          }}
        >
          Refresh chart history
        </button>{' '}
        <a href="/charts/detail">Exact history explorer →</a>
      </details>
      {sections.map(([group, icon, caption]) => {
        const defs = chartDefinitions.filter(
          (d) => d.group === group && (category === 'All' || d.categories.includes(category)),
        );
        if (!defs.length) return null;
        const cards = (
          <div
            className={`chart-grid ${group === 'Featured' ? 'featured-grid' : group === 'Staking' ? 'staking-grid' : ''}`}
          >
            {defs.map((def) =>
              def.id === 'maturities' ? (
                <MaturityCard key={def.id} />
              ) : (
                <HistoryCard
                  key={def.id}
                  def={def}
                  archive={archive.data}
                  native={native.data}
                  loading={loading}
                />
              ),
            )}
          </div>
        );
        return (
          <section
            className="chart-section"
            key={`${category}-${group}`}
            aria-label={`${group} charts`}
          >
            <div className="chart-section-heading">
              <h2>
                <Icon name={icon} />
                {group === 'Featured' ? 'Featured Charts' : group}
              </h2>
              <span>{caption}</span>
            </div>
            {group === 'Featured' || category !== 'All' ? (
              cards
            ) : (
              <LazySection>{cards}</LazySection>
            )}
          </section>
        );
      })}
    </div>
  );
}
