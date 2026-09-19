import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connect, databaseConfig } from '../../db/connect.ts';
import { profileSchema } from '../../worker/sync/profile.ts';
import { ProviderBudget } from '../../providers/budget.ts';
import { cooldownFiles } from '../../providers/cooldown.ts';
import { RpcClient, httpTransport } from '../../providers/rpc.ts';
import { AddressService } from './address.ts';
import { SqlAddressBaseline } from './baseline.ts';
import type { AddressBaseline } from './baseline.ts';

/** Task06 can own this lifetime. No public route or default provider access is enabled. */
export async function openAddressService(env = process.env, baseline?: AddressBaseline) {
  if (
    env.HDD_V2_ALLOW_LIVE_RPC !== 'true' ||
    !env.HDD_V2_SOURCE_PROFILE ||
    !env.HDD_V2_PROVIDER_STATE
  )
    throw new Error('Live address providers disabled; explicit profile/state/opt-in required.');
  const profile = profileSchema.parse(
    JSON.parse(await readFile(env.HDD_V2_SOURCE_PROFILE, 'utf8')),
  );
  const source = profile.pulsechain[0],
    endpoint = env[source.endpointEnv];
  if (!endpoint) throw new Error('Address source endpoint NOT_CONFIGURED.');
  const transport = httpTransport(endpoint);
  const client = await connect(databaseConfig('api', env), {
    signal: AbortSignal.timeout(5000),
    queryTimeoutMillis: 3000,
  });
  try {
    const {
      rows: [row],
    } = await client.query('SELECT pg_try_advisory_lock(4244,0) AS held');
    if (!row.held) throw new Error('API process role already active.');
    const controller = new AbortController();
    client.on('error', () => controller.abort(new Error('API quota ownership lost.')));
    client.on('end', () => controller.abort(new Error('API quota ownership ended.')));
    const cooldown = await cooldownFiles(resolve(env.HDD_V2_PROVIDER_STATE), 'api');
    const budget = new ProviderBudget('api', cooldown);
    const service = new AddressService(
      new RpcClient(source.id, source.operator, 369, profile.contract, transport, budget),
      profile.codeHash,
      baseline ?? new SqlAddressBaseline(client),
    );
    return {
      get: (address: string, signal: AbortSignal, pageSize?: number, cursor?: string) =>
        service.get(address, AbortSignal.any([signal, controller.signal]), pageSize, cursor),
      stake: (id: string, signal: AbortSignal, address?: string) =>
        service.stake(id, AbortSignal.any([signal, controller.signal]), address),
      async close() {
        controller.abort(new Error('API live services stopped.'));
        await client.end();
        await cooldown.close();
      },
    };
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}
