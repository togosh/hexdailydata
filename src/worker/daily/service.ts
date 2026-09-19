import type pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { contractDayAt } from '../../domain/day.ts';
import { rankAccounts } from './ranking.ts';
import {
  captureSample,
  configureMarket,
  finalizeMarkets,
  pruneSamples,
  type MarketSample,
} from './market.ts';
import { ExportService } from '../exports/service.ts';
import { snapshotIdentity } from '../exports/manifest.ts';

export async function capturePrice(
  client: pg.Client,
  chain: 1 | 369,
  source: string,
  sample: MarketSample,
) {
  try {
    const {
      rows: [s],
    } = await client.query(
      'SELECT from_day FROM hdd.market_sources WHERE chain_id=$1 AND source=$2',
      [chain, source],
    );
    await configureMarket(
      client,
      chain,
      source,
      'sampled-ohlc',
      s?.from_day ?? contractDayAt(BigInt(sample.sourceTime)),
    );
    await captureSample(client, chain, source, sample);
  } catch (e) {
    await client
      .query(
        "UPDATE hdd.market_sources SET capture_status='capture_error' WHERE chain_id=$1 AND source=$2 AND capture_status<>'byte_pressure'",
        [chain, source],
      )
      .catch(() => {});
    throw e;
  }
}
/** Durable scheduling is derived from accepted cutoffs/versions, so restart coalesces work. */
export class DailyService {
  readonly connect: () => Promise<pg.Client>;
  readonly exports: ExportService;
  readonly chain: 1 | 369;
  readonly status = {
    ticks: 0,
    ranks: 0,
    exports: 0,
    marketError: null as string | null,
    exportError: null as string | null,
  };
  constructor(connect: () => Promise<pg.Client>, root: string, chain: 1 | 369 = 369) {
    this.connect = connect;
    this.exports = new ExportService(connect, root);
    this.chain = chain;
  }
  async tick(signal: AbortSignal, now = Date.now(), force = false) {
    this.status.ticks++;
    const c = await this.connect();
    try {
      try {
        await finalizeMarkets(
          c,
          this.chain,
          contractDayAt(BigInt(Math.floor(now / 1000))) - 1,
          signal,
        );
        await pruneSamples(c, this.chain);
        this.status.marketError = null;
      } catch (e) {
        signal.throwIfAborted();
        this.status.marketError = (e as Error).message;
      }
      const {
        rows: [s],
      } = await c.query(
        `SELECT c.contract_day,r.ranking_day FROM hdd.current_state c LEFT JOIN hdd.rank_state r USING(chain_id) WHERE c.chain_id=$1`,
        [this.chain],
      );
      if (!s) {
        if (force) throw new Error('Native checkpoint unavailable for export.');
        return;
      }
      if (force || s.ranking_day === null || s.ranking_day < s.contract_day - 1) {
        await rankAccounts(c, this.chain, signal);
        this.status.ranks++;
      }
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let identity;
      try {
        identity = await snapshotIdentity(c, this.chain);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
      const {
        rows: [r],
      } = await c.query(
        "SELECT manifest,status FROM hdd.export_bundles WHERE chain_id=$1 AND slot='current'",
        [this.chain],
      );
      const key = (v: typeof identity) => [v.dailyCutoff, v.dailyPayoutBlock, v.ranking, v.markets];
      if (
        force ||
        !r ||
        r.status !== 'available' ||
        !isDeepStrictEqual(key(identity), key(r.manifest)) ||
        !(await this.exports.catalog(this.chain)).bundles.some((b) => b.id === r.manifest.id)
      ) {
        try {
          await this.exports.build(this.chain, signal);
          this.status.exports++;
          this.status.exportError = null;
        } catch (e) {
          signal.throwIfAborted();
          this.status.exportError = (e as Error).message;
          if (force) throw e;
        }
      }
    } finally {
      await c.end();
    }
  }
}
