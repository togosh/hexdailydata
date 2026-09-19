import type pg from 'pg';
import { HomeResponseSchema, type HomeResponse } from '../../contracts/api.ts';
import { age, unavailable } from '../../services/live/observations.ts';

export type Metrics = HomeResponse['live'];
export type Metric = keyof Metrics;
export const metricKeys: Metric[] = [
  'price',
  'shareRate',
  'todayPayoutEstimate',
  'latestCompletedPayout',
];
export const metricSchema = HomeResponseSchema.shape.live;
export interface MetricStore {
  read(chain: 1 | 369): Promise<Partial<Metrics>>;
  put<K extends Metric>(
    chain: 1 | 369,
    key: K,
    observation: Metrics[K],
    inputs?: Record<string, unknown>,
  ): Promise<void>;
}
export class SqlMetricStore implements MetricStore {
  readonly client: pg.Client;
  constructor(client: pg.Client) {
    this.client = client;
  }
  async read(chain: 1 | 369): Promise<Partial<Metrics>> {
    const { rows } = await this.client.query(
      'SELECT metric,observation FROM hdd.live_metrics WHERE chain_id=$1',
      [chain],
    );
    const result: Partial<Metrics> = {};
    for (const row of rows) {
      if (!metricKeys.includes(row.metric)) throw new Error('Unknown live metric.');
      Object.assign(result, {
        [row.metric]: metricSchema.shape[row.metric as Metric].parse(row.observation),
      });
    }
    return result;
  }
  async put<K extends Metric>(
    chain: 1 | 369,
    key: K,
    observation: Metrics[K],
    inputs: Record<string, unknown> = {},
  ) {
    const value = metricSchema.shape[key].parse(observation);
    if (value.asOf && value.asOf.chainId !== chain) throw new Error('Metric chain mismatch.');
    await this.client.query(
      `INSERT INTO hdd.live_metrics(chain_id,metric,observation,inputs) VALUES($1,$2,$3,$4)
      ON CONFLICT(chain_id,metric) DO UPDATE SET observation=excluded.observation,inputs=excluded.inputs`,
      [
        chain,
        key,
        JSON.stringify(value),
        JSON.stringify(inputs, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ],
    );
  }
}
export async function readMetrics(
  store: MetricStore,
  chain: 1 | 369,
  now: number,
): Promise<Metrics> {
  const rows = await store.read(chain);
  return metricSchema.parse(
    Object.fromEntries(
      metricKeys.map((key) => [
        key,
        age(rows[key] ?? unavailable(key, 'not_observed'), now, key === 'todayPayoutEstimate'),
      ]),
    ),
  );
}
