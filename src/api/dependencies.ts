import { databaseConfig } from '../db/connect.ts';
import { ReadDatabase } from '../services/queries/database.ts';
import { SqlAddressBaseline, type AddressBaseline } from '../services/live/baseline.ts';
import { openAddressService } from '../services/live/factory.ts';
import type { AddressService } from '../services/live/address.ts';
import { ExportService } from '../worker/exports/service.ts';

export interface ApiDependencies {
  db?: ReadDatabase;
  addresses?: Pick<AddressService, 'get' | 'stake'>;
  downloads?: Pick<ExportService, 'catalog' | 'openStream'>;
  close?: () => Promise<void>;
}
export function sqlBaseline(db: ReadDatabase): AddressBaseline {
  return {
    address: (chain, address, signal = AbortSignal.timeout(3000)) =>
      db.read(signal, (c) => new SqlAddressBaseline(c).address(chain, address)),
    stake: (chain, id, signal = AbortSignal.timeout(3000)) =>
      db.read(signal, (c) => new SqlAddressBaseline(c).stake(chain, id)),
  };
}
/** Connection setup is bounded; file verification runs independently of serving native data. */
export async function openDependencies(env = process.env): Promise<ApiDependencies> {
  if (!env.HDD_V2_DB_HOST) return {};
  const db = new ReadDatabase(databaseConfig('api', env));
  let addresses: Awaited<ReturnType<typeof openAddressService>> | undefined;
  if (env.HDD_V2_ALLOW_LIVE_RPC === 'true') {
    try {
      addresses = await openAddressService(env, sqlBaseline(db));
    } catch {
      await db.close();
      throw new Error('Live API configuration unavailable.');
    }
  }
  const downloads = env.HDD_V2_EXPORT_PATH
    ? new ExportService(() => db.connection(), env.HDD_V2_EXPORT_PATH)
    : undefined;
  const stop = new AbortController();
  let pending = Promise.resolve();
  const refresh = () => {
    if (downloads)
      pending = downloads
        .refresh(AbortSignal.any([stop.signal, AbortSignal.timeout(120000)]))
        .catch(() => {});
  };
  refresh();
  const timer = downloads ? setInterval(refresh, 5000).unref() : undefined;
  return {
    db,
    ...(addresses ? { addresses } : {}),
    ...(downloads ? { downloads } : {}),
    async close() {
      clearInterval(timer);
      stop.abort();
      await Promise.allSettled([pending, addresses?.close(), db.close()]);
    },
  };
}
