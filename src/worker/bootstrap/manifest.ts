import { z } from 'zod';
import { address, hash, integer } from '../../services/projections/input.ts';

// Order satisfies all FK dependencies. These names/keys are code, never archive SQL.
export const tables = {
  chains: ['chain_id'],
  source_history: ['chain_id'],
  sync_state: ['chain_id'],
  current_state: ['chain_id'],
  accounts: ['chain_id', 'address'],
  stakes: ['chain_id', 'stake_id'],
  share_schedule: ['chain_id', 'activation_day'],
  daily_stats: ['chain_id', 'contract_day'],
  blocks_recent: ['chain_id', 'number'],
  events: ['origin_chain_id', 'block_number', 'log_index'],
  transfers_recent: ['origin_chain_id', 'block_number', 'log_index'],
  checkpoints_recent: ['chain_id', 'revision'],
  undo_recent: ['sequence'],
  recovery_pins: ['chain_id', 'purpose'],
  rank_state: ['chain_id'],
  account_ranks: ['chain_id', 'address'],
  market_sources: ['chain_id', 'source'],
  market_samples: ['chain_id', 'source', 'identity'],
  market_daily: ['chain_id', 'source', 'contract_day'],
} as const;
export type Table = keyof typeof tables;
export const tableNames = Object.keys(tables) as Table[];
export const manifestSchema = z.strictObject({
  formatVersion: z.literal(3),
  schemaVersion: z.literal(4),
  calculationVersion: z.literal('hex-native-1'),
  createdAt: z.iso.datetime(),
  chainId: z.union([z.literal(1), z.literal(369)]),
  contractAddress: address,
  codeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  checkpoint: z.strictObject({
    blockNumber: integer,
    blockHash: hash,
    blockTime: integer,
    revision: integer,
    rewindFloor: integer,
    finality: z.enum(['confirmed', 'finalized']),
  }),
  lineage: z
    .strictObject({
      parentChainId: z.literal(1),
      parentBlockNumber: integer,
      parentBlockHash: hash,
      firstNativeBlockNumber: integer,
      firstNativeBlockHash: hash,
    })
    .optional(),
  coverage: z
    .array(
      z.strictObject({
        dataset: z.enum(['ethereum-native', 'pulsechain-native', 'market']),
        status: z.enum(['complete', 'missing']),
        from: integer.nullable(),
        to: integer.nullable(),
        reason: z.string().max(256).nullable(),
      }),
    )
    .min(2)
    .max(3),
  files: z
    .array(
      z.strictObject({
        table: z.enum(tableNames as [Table, ...Table[]]),
        path: z.string().regex(/^tables\/[a-z_]+\.ndjson$/),
        rows: integer,
        bytes: integer,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .length(tableNames.length),
});
export type Manifest = z.infer<typeof manifestSchema>;
