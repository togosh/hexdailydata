import { plot, type Point } from './history.ts';
import { chartNumber } from './charts.ts';

export default function ChartGraphic({
  points,
  secondary = [],
  title,
  bars = false,
}: {
  points: Point[];
  secondary?: Point[];
  title: string;
  bars?: boolean;
}) {
  const zero: Point = {
    key: 'zero',
    date: points[0]?.date ?? '2023-05-11',
    value: '0',
    detail: '',
    status: '',
  };
  const graph = plot([...points, ...secondary, ...(bars ? [zero] : [])]);
  const x = (v: number) => 49 + ((v - 70) * 335) / 700;
  const y = (v: number) => 20 + ((v - 35) * 128) / 185;
  const sets = [
    graph.coordinates.slice(0, points.length),
    graph.coordinates.slice(points.length, points.length + secondary.length),
  ];
  const baseline = bars ? y(graph.coordinates.at(-1)?.y ?? 220) : 148;
  return (
    <svg className="dashboard-graph" viewBox="0 0 400 185" role="img" aria-label={title}>
      {[20, 84, 148].map((v) => (
        <line key={v} x1="49" x2="384" y1={v} y2={v} className="gridline" />
      ))}
      <text x="43" y="24" textAnchor="end">
        {chartNumber(graph.maxLabel)}
      </text>
      <text x="43" y="151" textAnchor="end">
        {chartNumber(graph.minLabel)}
      </text>
      {sets.map((set, index) => {
        const counts = new Map<string, number>();
        set.forEach((p) => counts.set(p.date, (counts.get(p.date) ?? 0) + 1));
        const segments = set
          .map((p, i) => {
            const prev = set[i - 1];
            return prev?.y != null &&
              p.y != null &&
              Date.parse(p.date) - Date.parse(prev.date) === 86400000 &&
              counts.get(p.date) === 1 &&
              counts.get(prev.date) === 1
              ? `M${x(prev.x)},${y(prev.y)}L${x(p.x)},${y(p.y)}`
              : '';
          })
          .join(' ');
        const width = Math.min(12, 290 / Math.max(1, set.length)) / (secondary.length ? 2 : 1);
        return (
          <g key={index} className={index ? 'chart-secondary' : 'chart-primary'}>
            {!bars && (
              <path
                d={segments}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {set.map((p, i) =>
              p.y === null ? null : bars ? (
                <rect
                  key={p.key}
                  x={x(p.x) - width + index * width}
                  y={Math.min(y(p.y), baseline)}
                  width={width}
                  height={Math.abs(baseline - y(p.y))}
                  fill="currentColor"
                >
                  <title>
                    {p.date} · {p.value} · {p.detail}
                  </title>
                </rect>
              ) : set.length < 80 ||
                set[i - 1]?.y == null ||
                set[i + 1]?.y == null ||
                counts.get(p.date)! > 1 ? (
                <circle key={p.key} cx={x(p.x)} cy={y(p.y)} r="1.7" fill="currentColor">
                  <title>
                    {p.date} · {p.value}
                  </title>
                </circle>
              ) : null,
            )}
          </g>
        );
      })}
      <text x="49" y="178">
        {points[0]?.date}
      </text>
      <text x="384" y="178" textAnchor="end">
        {points.at(-1)?.date}
      </text>
    </svg>
  );
}
