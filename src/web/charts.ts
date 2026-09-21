import {
  archiveChartFields,
  nativeChartFields,
  type ArchiveCharts,
  type NativeCharts,
  type Maturities,
} from '../contracts/charts.ts';
import { displayRatio, formatUnits } from '../domain/units.ts';
import { dateShift, decimal, multiplyDecimals, compactNumber } from './format.ts';
import type { Point } from './history.ts';

export const categories = ['All', 'Price', 'Staking', 'Supply', 'Activity', 'Adoption'] as const;
export type Category = (typeof categories)[number];
type ArchiveField = (typeof archiveChartFields)[number] | 'cost';
type NativeField = (typeof nativeChartFields)[number];
export type ChartDefinition = {
  id: string;
  title: string;
  unit: string;
  group: string;
  categories: Category[];
  archive?: ArchiveField;
  native?: NativeField;
  secondaryArchive?: ArchiveField;
  secondaryNative?: NativeField;
  secondaryLabel?: string;
  paired?: boolean;
  bars?: boolean;
};
export const chartDefinitions: ChartDefinition[] = [
  {
    id: 'price',
    title: 'HEX Price',
    unit: 'USD / HEX',
    group: 'Featured',
    categories: ['Price'],
    archive: 'price',
  },
  {
    id: 'payout',
    title: 'Payout per T-Share',
    unit: 'HEX / T-Share',
    group: 'Featured',
    categories: ['Staking'],
    archive: 'payoutPerTshareHEX',
    native: 'payout',
  },
  {
    id: 'rate',
    title: 'T-Share Rate',
    unit: 'HEX / T-Share',
    group: 'Staking',
    categories: ['Staking'],
    archive: 'tshareRateHEX',
    native: 'rate',
  },
  {
    id: 'shares',
    title: 'Total T-Shares',
    unit: 'T-Shares',
    group: 'Staking',
    categories: ['Staking'],
    archive: 'totalTshares',
  },
  {
    id: 'staked',
    title: 'Staked HEX + % Staked',
    unit: 'HEX',
    group: 'Staking',
    categories: ['Staking', 'Supply'],
    archive: 'stakedHEX',
    native: 'locked',
    secondaryArchive: 'stakedHEXPercent',
    secondaryNative: 'percent',
    secondaryLabel: '% staked',
  },
  {
    id: 'duration',
    title: 'Average Stake Length',
    unit: 'years · 365 days',
    group: 'Staking',
    categories: ['Staking'],
    archive: 'averageStakeLength',
    native: 'duration',
  },
  {
    id: 'stakers',
    title: 'Current Stakers',
    unit: 'addresses',
    group: 'Staking',
    categories: ['Staking', 'Adoption'],
    archive: 'currentStakerCount',
    native: 'stakers',
  },
  {
    id: 'maturities',
    title: 'Upcoming Maturities',
    unit: 'HEX',
    group: 'Staking',
    categories: ['Staking'],
  },
  {
    id: 'supply',
    title: 'Circulating HEX vs Staked HEX',
    unit: 'HEX',
    group: 'Supply',
    categories: ['Supply'],
    archive: 'circulatingHEX',
    native: 'circulating',
    secondaryArchive: 'stakedHEX',
    secondaryNative: 'locked',
    secondaryLabel: 'Staked',
    paired: true,
  },
  {
    id: 'cost',
    title: 'T-Share Cost USD',
    unit: 'USD / T-Share',
    group: 'Supply',
    categories: ['Supply', 'Price'],
    archive: 'cost',
  },
  {
    id: 'activity',
    title: 'New vs Ended Stakes',
    unit: 'stakes / day',
    group: 'Activity',
    categories: ['Activity'],
    native: 'starts',
    secondaryNative: 'ends',
    secondaryLabel: 'Ended',
    paired: true,
    bars: true,
  },
  {
    id: 'penalties',
    title: 'Daily Penalties',
    unit: 'HEX',
    group: 'Activity',
    categories: ['Activity'],
    archive: 'penaltiesHEX',
    native: 'penalties',
    bars: true,
  },
  {
    id: 'holders',
    title: 'Current HEX Holders',
    unit: 'addresses',
    group: 'Adoption',
    categories: ['Adoption'],
    archive: 'currentHolders',
    native: 'holders',
  },
];
export type ChartRange = '30D' | '1Y' | 'ALL';
/** Bounded chart labels; exact expanded strings remain available in focused records. */
export function chartNumber(value: string | null | undefined, places = 2) {
  if (value == null) return 'Unavailable';
  const expanded = decimal(value);
  const match = /^(-?)0\.(0{8,})([1-9]\d*)$/.exec(expanded);
  if (match)
    return `${match[1]}${match[3]![0]}.${(match[3]!.slice(1, 3) + '00').slice(0, 2)} × 10^-${match[2]!.length + 1}`;
  return compactNumber(value, places);
}
const field = (values: (string | null)[], fields: readonly string[], key: string) =>
  values[fields.indexOf(key)] ?? null;
export function archiveValue(row: ArchiveCharts['items'][number], key: ArchiveField) {
  return key === 'cost'
    ? multiplyDecimals(
        field(row.values, archiveChartFields, 'tshareRateHEX'),
        field(row.values, archiveChartFields, 'price'),
      )
    : field(row.values, archiveChartFields, key);
}
function nativeValue(row: NativeCharts['items'][number], key: NativeField) {
  const value = field(row.values, nativeChartFields, key);
  if (key !== 'duration' || value === null) return value;
  const [whole = '0', fraction = ''] = decimal(value).split('.');
  return displayRatio({
    numerator: BigInt(whole + fraction),
    denominator: 365n * 10n ** BigInt(fraction.length),
  });
}
export function seriesFor(
  def: ChartDefinition,
  archive: ArchiveCharts | undefined,
  native: NativeCharts | undefined,
  range: ChartRange,
) {
  const a = def.archive ? (archive?.items ?? []) : [];
  const n = def.native ? (native?.items ?? []) : [];
  const end = [a.at(-1)?.date, n.at(-1)?.date]
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);
  const start =
    end && range !== 'ALL'
      ? dateShift(end, range === '30D' ? -29 : -364)
      : [a[0]?.date, n[0]?.date].filter((v): v is string => !!v).sort()[0];
  const inRange = (row: { date: string }) =>
    !!start && !!end && row.date >= start && row.date <= end;
  const nativeRows = n.filter(inRange),
    archiveRows = a.filter(inRange);
  const nativeComplete =
    !!start &&
    !!end &&
    nativeRows.length === (Date.parse(end) - Date.parse(start)) / 86400000 + 1 &&
    nativeRows.every(
      (r, i) =>
        r.date === dateShift(start, i) &&
        nativeValue(r, def.native!) !== null &&
        (!def.secondaryNative || nativeValue(r, def.secondaryNative) !== null),
    );
  const archiveUseful = archiveRows.some((r) => archiveValue(r, def.archive!) !== null);
  const useNative = !!def.native && (nativeComplete || !archiveUseful);
  const source = useNative ? 'native' : 'hds';
  const points = (secondary = false): Point[] =>
    useNative
      ? nativeRows.map((r) => ({
          key: String(r.day),
          date: r.date,
          value: (secondary ? def.secondaryNative : def.native)
            ? nativeValue(r, (secondary ? def.secondaryNative : def.native)!)
            : null,
          status: 'Native completed-day',
          detail: `Contract day ${r.day} / display ${r.day + 1} · ${r.originChainId === 1 ? 'inherited Ethereum' : 'PulseChain'} origin`,
        }))
      : archiveRows.map((r) => ({
          key: String(r.day),
          date: r.date,
          value: (secondary ? def.secondaryArchive : def.archive)
            ? archiveValue(r, (secondary ? def.secondaryArchive : def.archive)!)
            : null,
          status: def.id === 'cost' ? 'Derived · HDS' : 'HDS reported',
          detail: `HDS sourceDay ${r.day} · source-record date; market period unproved`,
        }));
  const primary = points();
  const gaps = primary.some(
    (p, i) =>
      p.value === null ||
      (i > 0 && Date.parse(p.date) - Date.parse(primary[i - 1]!.date) !== 86400000),
  );
  return {
    source: source as 'hds' | 'native',
    points: primary,
    secondary: points(true),
    start,
    end,
    partial: useNative && !nativeComplete,
    gaps,
    truncated: useNative && !!native?.truncated,
  };
}
export function detailHref(def: ChartDefinition, selected: ReturnType<typeof seriesFor>) {
  const from = selected.points[0]?.date ?? selected.start;
  const to = selected.points.at(-1)?.date ?? selected.end;
  const q = new URLSearchParams({
    source: selected.source,
    metric: (selected.source === 'native' ? def.native : def.archive) ?? 'payout',
  });
  if (from && to) {
    q.set('from', from);
    q.set('to', to);
  }
  return '/charts/detail?' + q;
}
export type MaturityUnit = 'HEX' | 'T-Shares' | 'Stake Count';
export function maturitySeries(data: Maturities, days: number, unit: MaturityUnit) {
  const last = data.items.at(-1)?.day ?? data.cutoff.contractDay + 1;
  const through = Math.min(65535, days ? data.cutoff.contractDay + days : last);
  const selected = data.items.filter((r) => r.day <= through);
  const raw = (r: Maturities['items'][number]) =>
    BigInt(unit === 'HEX' ? r.principalHearts : unit === 'T-Shares' ? r.stakeShares : r.count);
  const value = (v: bigint) => formatUnits(v, unit === 'HEX' ? 8 : unit === 'T-Shares' ? 12 : 0);
  // At most 60 bars; sums use raw integers and retain each bin's inclusive day interval.
  const width = Math.max(1, Math.ceil((through - data.cutoff.contractDay) / 60));
  const bins = new Map<number, bigint>();
  for (const row of selected) {
    const offset = Math.floor((row.day - data.cutoff.contractDay - 1) / width);
    bins.set(offset, (bins.get(offset) ?? 0n) + raw(row));
  }
  const points: Point[] = [];
  for (let i = 0; i * width < through - data.cutoff.contractDay; i++) {
    const from = data.cutoff.contractDay + 1 + i * width,
      to = Math.min(through, from + width - 1);
    points.push({
      key: String(from),
      date: dateShift('2019-12-03', from),
      value: value(bins.get(i) ?? 0n),
      status: 'Indexed future schedule',
      detail: `Contract days ${from}–${to} · ${unit}`,
    });
  }
  return {
    points,
    total: value(selected.reduce((v, r) => v + raw(r), 0n)),
    count: selected.reduce((v, r) => v + BigInt(r.count), 0n).toString(),
    beyond: data.items.some((r) => r.day > through),
    width,
  };
}
