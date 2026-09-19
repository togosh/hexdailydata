import pg from 'pg';

export type DbRole = 'api' | 'worker' | 'migrator';
export interface DatabaseConfig {
  host: string;
  database: string;
  user: string;
  password: string;
  instance: string;
}
export function databaseConfig(role: DbRole, env = process.env): DatabaseConfig {
  const config = {
    host: env.HDD_V2_DB_HOST ?? '',
    database: env.HDD_V2_DB_NAME ?? '',
    user: `hdd_v2_${role}`,
    password: env[`HDD_V2_${role.toUpperCase()}_PASSWORD`] ?? '',
    instance: env.HDD_V2_DB_INSTANCE ?? '',
  };
  if (
    config.host !== 'db' ||
    config.database !== 'hexdailydata_v2' ||
    !/^[0-9a-f-]{36}$/.test(config.instance) ||
    config.password.length < 24
  ) {
    throw new Error(
      'Explicit private v2 database target, instance UUID and role password required.',
    );
  }
  return config;
}
export async function connect(
  config: DatabaseConfig,
  bounds: { signal?: AbortSignal; queryTimeoutMillis?: number } = {},
): Promise<pg.Client> {
  if (
    config.host !== 'db' ||
    config.database !== 'hexdailydata_v2' ||
    !['hdd_v2_api', 'hdd_v2_worker', 'hdd_v2_migrator'].includes(config.user) ||
    !/^[0-9a-f-]{36}$/.test(config.instance) ||
    config.password.length < 24
  ) {
    throw new Error('Invalid v2 database target.');
  }
  const client = new pg.Client({
    ...config,
    port: 5432,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
    application_name: 'hexdailydata-v2',
    ...(bounds.queryTimeoutMillis === undefined
      ? {}
      : { query_timeout: bounds.queryTimeoutMillis }),
  });
  bounds.signal?.throwIfAborted();
  const abort = () => {
    void client.end().catch(() => {});
  };
  bounds.signal?.addEventListener('abort', abort, { once: true });
  try {
    await client.connect();
    const {
      rows: [row],
    } = await client.query(`SELECT current_database() AS db,
      current_user AS role, current_setting('server_version_num')::int AS version,
      (SELECT instance::text FROM hdd_identity.instance WHERE singleton) AS instance,
      rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user`);
    if (
      row.db !== config.database ||
      row.instance !== config.instance ||
      row.role !== config.user ||
      row.version < 170000 ||
      row.version >= 180000 ||
      row.rolsuper ||
      row.rolcreaterole ||
      row.rolcreatedb
    ) {
      throw new Error('Wrong or incompatible v2 database identity/role.');
    }
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  } finally {
    bounds.signal?.removeEventListener('abort', abort);
  }
}
