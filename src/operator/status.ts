import { readFile, stat } from 'node:fs/promises';
import { connect, databaseConfig } from '../db/connect.ts';
import { ReadDatabase } from '../services/queries/database.ts';
import { status } from '../services/queries/home.ts';
import { developmentConfig } from '../api/config.ts';
import { backupStatus } from './backup.ts';
import { reserve, writable } from './files.ts';

/** Bounded observations only. No migration, provider, archive hash or history audit. */
export async function operatorStatus(env = process.env) {
  const config = developmentConfig(env);
  let schemaState = 'unconfigured';
  if (env.HDD_V2_DB_HOST) {
    let c: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      c = await connect(databaseConfig('api', env));
      c.on('error', () => {});
      const present = (await c.query("SELECT to_regclass('hdd.schema_migrations') AS name")).rows[0]
        .name;
      schemaState = present
        ? (await c.query('SELECT version FROM hdd.schema_migrations ORDER BY version LIMIT 6')).rows
            .map((r) => r.version)
            .join(',') === '1,2,3,4'
          ? 'supported'
          : 'unsupported'
        : 'uninitialized';
    } catch {
      schemaState = 'unavailable';
    } finally {
      await c?.end().catch(() => {});
    }
  }
  const paths: Record<string, unknown> = {};
  for (const key of [
    'HDD_V2_EXPORT_PATH',
    'HDD_V2_STORAGE_PATH',
    'HDD_V2_MAINTENANCE_PATH',
    'HDD_V2_BACKUP_PATH',
  ]) {
    if (!env[key]) {
      paths[key] = 'not_configured';
      continue;
    }
    try {
      await writable(env[key]!);
      paths[key] = { state: 'available', ...(await reserve(env[key]!)) };
    } catch {
      paths[key] = 'unavailable_or_low_reserve';
    }
  }
  let db: ReadDatabase | undefined;
  try {
    if (env.HDD_V2_DB_HOST) db = new ReadDatabase(databaseConfig('api', env));
  } catch {
    /* report unavailable below */
  }
  try {
    const runtime = await status(
      db,
      'pulsechain',
      AbortSignal.timeout(8000),
      Date.now(),
      env.HDD_V2_ALLOW_LIVE_RPC === 'true',
      config.mode,
    );
    let publications: unknown = 'unavailable',
      restore: unknown = null;
    if (db)
      try {
        const rows = await db.read(
          AbortSignal.timeout(5000),
          async (c) =>
            (
              await c.query(
                'SELECT id::text,slot,status,published_at FROM hdd.export_bundles ORDER BY published_at DESC LIMIT 3',
              )
            ).rows,
        );
        publications = await Promise.all(
          rows.map(async (r) => {
            let present = Boolean(env.HDD_V2_EXPORT_PATH);
            if (present)
              for (const name of [
                'manifest.json',
                'daily.csv',
                'stakes.csv',
                'holders.csv',
                'maturities.csv',
                'markets.csv',
              ]) {
                try {
                  if (!(await stat(`${env.HDD_V2_EXPORT_PATH}/${r.id}/${name}`)).isFile())
                    present = false;
                } catch {
                  present = false;
                }
              }
            return { ...r, bytes: present ? 'present_not_rehashed' : 'missing' };
          }),
        );
      } catch {
        /* bounded failure */
      }
    if (env.HDD_V2_MAINTENANCE_PATH)
      try {
        const p = env.HDD_V2_MAINTENANCE_PATH + '/restore.json';
        if ((await stat(p)).size <= 16384) restore = JSON.parse(await readFile(p, 'utf8'));
      } catch {
        /* no restore */
      }
    return {
      node: process.versions.node,
      runtime:
        Number(process.versions.node.split('.')[0]) === 24 &&
        Number(process.versions.node.split('.')[1]) >= 21
          ? 'supported'
          : 'unsupported',
      release: env.HDD_V2_RELEASE ?? 'development',
      schema: runtime.database === 'ready' ? 4 : null,
      schemaState,
      ...runtime,
      paths,
      publications,
      backup: await backupStatus(env),
      restore,
      providerProbe: 'NOT_RUN',
      productionReady: false,
    };
  } finally {
    await db?.close();
  }
}
