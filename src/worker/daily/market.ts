import type pg from 'pg';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { rational, parseUnits, type Rational } from '../../domain/units.ts';
import { contractDayAt, dayStartSeconds } from '../../domain/day.ts';

import { marketObservationSchema } from '../../contracts/market.ts';
export { marketObservationSchema } from '../../contracts/market.ts';
type Observation = z.infer<typeof marketObservationSchema>;
const sourceSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const wire = (r: Rational) => ({
  numerator: r.numerator.toString(),
  denominator: r.denominator.toString(),
});
const compare = (a: NonNullable<Observation['open']>, b: NonNullable<Observation['open']>) =>
  BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
export const sampleLimitBytes = 64 * 1024 * 1024;
export async function configureMarket(
  client: pg.Client,
  chain: 1 | 369,
  source: string,
  method: 'sampled-ohlc' | 'source-reported',
  fromDay: number,
) {
  sourceSchema.parse(source);
  if (!Number.isInteger(fromDay) || fromDay < 0 || fromDay > 65535)
    throw new Error('Invalid market start.');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(4246,0)');
    const { rows } = await client.query('SELECT * FROM hdd.market_sources WHERE chain_id=$1', [
      chain,
    ]);
    const old = rows.find((r) => r.source === source);
    if (old && (old.method !== method || old.from_day !== fromDay))
      throw new Error('Source definition is immutable.');
    if (!old && rows.length >= 4) throw new Error('At most four declared market sources.');
    await client.query(
      `INSERT INTO hdd.market_sources(chain_id,source,method,native,qualification,from_day)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        chain,
        source,
        method,
        method === 'sampled-ohlc',
        method === 'sampled-ohlc' ? 'peg_assumed' : 'source_reported_usd',
        fromDay,
      ],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
export interface MarketSample {
  identity: string;
  sourceTime: string;
  observedTime: string;
  blockNumber: string | null;
  blockHash: string | null;
  poolTime: string | null;
  revision: string;
  observation: Observation;
}
/** No provider I/O here. Caller supplies qualified reserve observations or validated venue bars. */
export async function captureSample(
  client: pg.Client,
  chain: 1 | 369,
  source: string,
  input: MarketSample,
) {
  sourceSchema.parse(source);
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(input.identity)) throw new Error('Invalid market identity.');
  const observation = marketObservationSchema.parse(input.observation);
  if (
    !/^(0|[1-9][0-9]{0,18})$/.test(input.revision) ||
    input.blockNumber !== observation.blockNumber ||
    input.blockHash !== observation.blockHash ||
    input.poolTime !== observation.poolTime
  )
    throw new Error('Sample metadata mismatch.');
  const day = contractDayAt(BigInt(input.sourceTime));
  if (
    observation.intervals !== 1 ||
    observation.sourceTime !== input.sourceTime ||
    observation.observedTime !== input.observedTime ||
    BigInt(input.observedTime) < BigInt(input.sourceTime)
  )
    throw new Error('Sample time/interval mismatch.');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock_shared(4243,0)');
    const {
      rows: [s],
    } = await client.query(
      'SELECT * FROM hdd.market_sources WHERE chain_id=$1 AND source=$2 FOR UPDATE',
      [chain, source],
    );
    if (!s || day < s.from_day) throw new Error('Market source outside configured coverage.');
    if (s.native && input.revision !== '0')
      throw new Error('Native block observations are immutable.');
    if (!s.native && (input.identity !== input.sourceTime || BigInt(input.sourceTime) % 60n !== 0n))
      throw new Error('Venue identity must be interval start.');
    if (
      s.native &&
      (!input.blockNumber ||
        !input.blockHash ||
        input.poolTime === null ||
        observation.volume !== null ||
        observation.liquidity !== null)
    )
      throw new Error('Invalid native sample.');
    if (
      !s.native &&
      (input.blockNumber !== null || input.blockHash !== null || input.poolTime !== null)
    )
      throw new Error('Venue observations cannot claim a native block.');
    const {
      rows: [old],
    } = await client.query(
      `SELECT *,pg_column_size(m) AS bytes FROM hdd.market_samples m
      WHERE chain_id=$1 AND source=$2 AND identity=$3`,
      [chain, source, input.identity],
    );
    if (
      old &&
      (old.source_time !== input.sourceTime ||
        old.block_number !== input.blockNumber ||
        (old.block_hash?.toString('hex') ?? null) !== (input.blockHash?.slice(2) ?? null))
    )
      throw new Error('Conflicting sample identity.');
    if (old && BigInt(old.revision) >= BigInt(input.revision)) {
      // Retry collection time is not a new event. At the same revision values must agree.
      const a = { ...old.observation, observedTime: null },
        b = { ...observation, observedTime: null };
      if (old.revision === input.revision && !isDeepStrictEqual(a, b))
        throw new Error('Conflicting sample revision.');
      await client.query('COMMIT');
      return false;
    }
    if (s.through_day !== null && day <= s.through_day - 7 && !old)
      throw new Error('Sample correction needs unavailable retired inputs.');
    if (Number(s.sample_bytes) + 8192 > sampleLimitBytes) {
      await client.query(
        "UPDATE hdd.market_sources SET capture_status='byte_pressure' WHERE chain_id=$1 AND source=$2",
        [chain, source],
      );
      await client.query('COMMIT');
      throw new Error('Market capture paused: byte_pressure; required samples retained.');
    }
    const {
      rows: [r],
    } = await client.query(
      `INSERT INTO hdd.market_samples AS m
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(chain_id,source,identity) DO UPDATE SET observation=excluded.observation,
      observed_time=excluded.observed_time,revision=excluded.revision RETURNING pg_column_size(m) AS bytes`,
      [
        chain,
        source,
        input.identity,
        input.sourceTime,
        input.observedTime,
        input.blockNumber,
        input.blockHash ? Buffer.from(input.blockHash.slice(2), 'hex') : null,
        input.poolTime,
        day,
        Number((BigInt(input.sourceTime) - dayStartSeconds(day)) / 60n),
        JSON.stringify(observation),
        input.revision,
      ],
    );
    await client.query(
      `UPDATE hdd.market_sources SET dirty_day=least(dirty_day,$3),
      sample_bytes=sample_bytes+$4,capture_status='ready' WHERE chain_id=$1 AND source=$2`,
      [chain, source, day, r.bytes - (old?.bytes ?? 0)],
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
export function priceSample(input: {
  identity: string;
  sourceTime: string;
  observedTime: string;
  blockNumber: string;
  blockHash: string;
  poolTime: string;
  price: Rational;
}): MarketSample {
  const p = wire(rational(input.price.numerator, input.price.denominator));
  return {
    ...input,
    revision: '0',
    observation: {
      open: p,
      high: p,
      low: p,
      close: p,
      volume: null,
      liquidity: null,
      intervals: 1,
      expectedIntervals: 1440,
      coverage: 'partial',
      sourceTime: input.sourceTime,
      observedTime: input.observedTime,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      poolTime: input.poolTime,
    },
  };
}
const decimal = z
  .string()
  .max(100)
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/);
const barSchema = z.strictObject({
  time: z.number().int().min(1575331200).max(7237635199),
  revision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  open: decimal,
  high: decimal,
  low: decimal,
  close: decimal,
  volume: decimal.nullable(),
  liquidity: decimal.nullable(),
});
/** Narrow minute-bar transport contract; called by offline CLI or a future qualified sync-lane adapter. */
export async function importMarketBars(
  client: pg.Client,
  raw: unknown,
  nowSeconds: number,
  signal: AbortSignal,
) {
  const input = z
    .strictObject({
      chain: z.union([z.literal(1), z.literal(369)]),
      source: sourceSchema,
      bars: z.array(barSchema).min(1).max(1440),
    })
    .parse(raw);
  const {
    rows: [s],
  } = await client.query('SELECT method FROM hdd.market_sources WHERE chain_id=$1 AND source=$2', [
    input.chain,
    input.source,
  ]);
  if (s?.method !== 'source-reported') throw new Error('Source-reported profile NOT_CONFIGURED.');
  for (const bar of input.bars) {
    signal.throwIfAborted();
    if (bar.time % 60 || bar.time + 60 > nowSeconds)
      throw new Error('Incomplete/future source interval.');
    const ratios = [bar.open, bar.high, bar.low, bar.close].map((v) =>
      wire(rational(parseUnits(v, 24), 10n ** 24n)),
    );
    const [o, h, l, c] = ratios as [
      NonNullable<Observation['open']>,
      NonNullable<Observation['open']>,
      NonNullable<Observation['open']>,
      NonNullable<Observation['open']>,
    ];
    if (
      compare(h, o) < 0 ||
      compare(h, c) < 0 ||
      compare(l, o) > 0 ||
      compare(l, c) > 0 ||
      compare(l, h) > 0
    )
      throw new Error('Invalid OHLC range.');
    await captureSample(client, input.chain, input.source, {
      identity: String(bar.time),
      sourceTime: String(bar.time),
      observedTime: String(nowSeconds),
      blockNumber: null,
      blockHash: null,
      poolTime: null,
      revision: bar.revision,
      observation: {
        open: o,
        high: h,
        low: l,
        close: c,
        volume: bar.volume === null ? null : parseUnits(bar.volume, 24).toString(),
        liquidity: bar.liquidity === null ? null : parseUnits(bar.liquidity, 24).toString(),
        intervals: 1,
        expectedIntervals: 1440,
        coverage: 'partial',
        sourceTime: String(bar.time),
        observedTime: String(nowSeconds),
        blockNumber: null,
        blockHash: null,
        poolTime: null,
      },
    });
  }
}
/** Reconstruct one retained day inside the caller transaction, using bounded cursor batches. */
export async function retainedMarketDay(
  client: pg.Client,
  chain: 1 | 369,
  source: string,
  day: number,
  signal: AbortSignal,
): Promise<Observation> {
  let result: Observation = {
    open: null,
    high: null,
    low: null,
    close: null,
    volume: null,
    liquidity: null,
    intervals: 0,
    expectedIntervals: 1440,
    coverage: 'missing',
    sourceTime: null,
    observedTime: null,
    blockNumber: null,
    blockHash: null,
    poolTime: null,
  };
  let lastInterval = -1,
    volume = 0n,
    hasVolume = true;
  await client.query(
    `DECLARE market_rows NO SCROLL CURSOR FOR SELECT interval_number,observation FROM hdd.market_samples
  WHERE chain_id=$1 AND source=$2 AND contract_day=$3 ORDER BY source_time,identity`,
    [chain, source, day],
  );
  for (;;) {
    const { rows } = await client.query('FETCH FORWARD 128 FROM market_rows');
    if (!rows.length) break;
    for (const row of rows) {
      signal.throwIfAborted();
      const v = marketObservationSchema.parse(row.observation);
      if (result.open === null) result.open = v.open;
      if (!result.high || compare(v.high!, result.high) > 0) result.high = v.high;
      if (!result.low || compare(v.low!, result.low) < 0) result.low = v.low;
      result.close = v.close;
      result.sourceTime = v.sourceTime;
      result.observedTime = v.observedTime;
      result.blockNumber = v.blockNumber;
      result.blockHash = v.blockHash;
      result.poolTime = v.poolTime;
      result.liquidity = v.liquidity;
      if (row.interval_number !== lastInterval) {
        result.intervals++;
        lastInterval = row.interval_number;
      }
      if (v.volume === null) hasVolume = false;
      else volume += BigInt(v.volume);
    }
  }
  await client.query('CLOSE market_rows');
  result.volume = result.intervals && hasVolume ? volume.toString() : null;
  result.coverage =
    result.intervals === 1440 ? 'complete' : result.intervals ? 'partial' : 'missing';
  result = marketObservationSchema.parse(result);
  return result;
}
export async function finalizeMarkets(
  client: pg.Client,
  chain: 1 | 369,
  throughDay: number,
  signal: AbortSignal,
) {
  if (!Number.isInteger(throughDay) || throughDay < 0 || throughDay > 65535)
    throw new Error('Invalid market cutoff.');
  const { rows: sources } = await client.query(
    'SELECT source FROM hdd.market_sources WHERE chain_id=$1 ORDER BY source',
    [chain],
  );
  let changed = 0;
  for (const { source } of sources)
    for (let jobs = 0; jobs < 31; jobs++) {
      signal.throwIfAborted();
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL statement_timeout='30s'");
        await client.query('SELECT pg_advisory_xact_lock_shared(4243,0)');
        const {
          rows: [s],
        } = await client.query(
          'SELECT * FROM hdd.market_sources WHERE chain_id=$1 AND source=$2 FOR UPDATE',
          [chain, source],
        );
        const day = Math.min(
          s.dirty_day ?? Infinity,
          s.through_day === null ? s.from_day : s.through_day + 1,
        );
        if (day > throughDay) {
          await client.query('COMMIT');
          break;
        }
        const result = await retainedMarketDay(client, chain, source, day, signal);
        const updated = await client.query(
          `INSERT INTO hdd.market_daily VALUES($1,$2,$3,$4) ON CONFLICT(chain_id,source,contract_day)
        DO UPDATE SET observation=excluded.observation WHERE hdd.market_daily.observation IS DISTINCT FROM excluded.observation`,
          [chain, source, day, JSON.stringify(result)],
        );
        await client.query(
          `UPDATE hdd.market_sources SET through_day=greatest(through_day,$3),version=version+$4,
        dirty_day=CASE WHEN dirty_day<=$3 THEN (SELECT min(contract_day) FROM hdd.market_samples WHERE chain_id=$1 AND source=$2 AND contract_day>$3) ELSE dirty_day END
        WHERE chain_id=$1 AND source=$2`,
          [chain, source, day, updated.rowCount],
        );
        await client.query('COMMIT');
        changed++;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    }
  return changed;
}
export async function pruneSamples(client: pg.Client, chain: 1 | 369) {
  await client.query('BEGIN');
  try {
    const {
      rows: [l],
    } = await client.query('SELECT pg_try_advisory_xact_lock(4243,0) AS held');
    if (!l.held) {
      await client.query('COMMIT');
      return 0;
    }
    await client.query('SELECT source FROM hdd.market_sources WHERE chain_id=$1 FOR UPDATE', [
      chain,
    ]);
    const result = await client.query(
      `DELETE FROM hdd.market_samples m USING hdd.market_sources s
      WHERE m.chain_id=$1 AND s.chain_id=m.chain_id AND s.source=m.source AND m.contract_day<=s.through_day-7
      AND (s.dirty_day IS NULL OR m.contract_day<s.dirty_day)`,
      [chain],
    );
    await client.query(
      `UPDATE hdd.market_sources s SET sample_bytes=(SELECT coalesce(sum(pg_column_size(m)),0)
      FROM hdd.market_samples m WHERE m.chain_id=s.chain_id AND m.source=s.source) WHERE s.chain_id=$1`,
      [chain],
    );
    await client.query('COMMIT');
    return result.rowCount;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
