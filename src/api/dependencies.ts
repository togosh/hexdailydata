import type { SourceStakeReader } from '../services/source-stakes/store.ts';
import type { SourceHolderReader } from '../services/source-holders/store.ts';
import { databaseConfig } from '../db/connect.ts';
import { ReadDatabase } from '../services/queries/database.ts';
import { SqlAddressBaseline, type AddressBaseline } from '../services/live/baseline.ts';
import { openAddressService } from '../services/live/factory.ts';
import type { AddressService } from '../services/live/address.ts';
import { ExportService } from '../worker/exports/service.ts';
import type { DailyLedgerReader } from '../services/daily-ledger/store.ts';

import type { SavedSourceGenerations } from '../services/source-update/generation.ts';

import type { ProductDailyStore } from '../services/product-daily/store.ts';

import type { ParticipantRegistry } from '../services/source-update/refresh.ts';

export interface ApiDependencies {
  participants?: ParticipantRegistry;
  productDaily?: ProductDailyStore;
  sourceGenerations?: SavedSourceGenerations;
  dailyLedger?: DailyLedgerReader;
  sourceStakes?: SourceStakeReader;
  sourceHolders?: SourceHolderReader;
  db?: ReadDatabase;
  addresses?: Pick<AddressService, 'get' | 'stake'>;
  downloads?: Pick<ExportService, 'catalog' | 'openStream'> &
    Partial<Pick<ExportService, 'root'>>;
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
  const mode = env.HDD_V2_API_MODE ?? 'product';
  if (mode === 'product') {
    if (
      !env.HDD_V2_PRODUCT_PROFILE ||
      env.HDD_V2_DB_HOST ||
      env.HDD_V2_ALLOW_LIVE_RPC === 'true' ||
      env.HDD_V2_EXPORT_PATH
    )
      throw Error('PRODUCT_PROFILE_REQUIRED_WITHOUT_LEGACY_RUNTIME');
    const { readProductProfile, openProductDependencies } =
      await import('../services/product-daily/open.ts');
    return openProductDependencies(await readProductProfile(env.HDD_V2_PRODUCT_PROFILE));
  }
  if (mode !== 'legacy-sql' || env.HDD_V2_PRODUCT_PROFILE || !env.HDD_V2_DB_HOST)
    throw Error('EXPLICIT_LEGACY_SQL_CONFIGURATION_REQUIRED');
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
      await Promise.allSettled([
        pending,
        addresses?.close(),
        downloads?.closeReaders(),
        db.close(),
      ]);
    },
  };
}
