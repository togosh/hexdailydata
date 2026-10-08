import { SavedHoldersResponseSchema, SavedStakesResponseSchema, SavedStakeResponseSchema, SavedAddressResponseSchema } from '../contracts/source-update.ts';
import { SourceStakesQuery, SourceStakeQuery, SourceStakesResponseSchema, SourceStakeResponseSchema } from '../contracts/source-stakes.ts';
import { SourceAddressQuery, SourceAddressResponseSchema } from '../contracts/source-address.ts';
import { SourceHoldersQuery, SourceHoldersResponseSchema } from '../contracts/source-holders.ts';
import { StakeEventsQuery, StakeEventsResponseSchema } from '../contracts/stake-events.ts';
import { z } from 'zod';
import { HomeResponseSchema, StatusResponseSchema } from '../contracts/api.ts';
import {
  ChainQuery,
  DailyQuery,
  MarketQuery,
  StakesQuery,
  StakeQuery,
  HoldersQuery,
  AddressQuery,
  AddressSchema,
  StakeIdSchema,
  DailyResponseSchema,
  MarketResponseSchema,
  StakesResponseSchema,
  StakeResponseSchema,
  HoldersResponseSchema,
  CalculatorResponseSchema,
  AddressResultSchema,
  DownloadsResponseSchema,
} from '../contracts/reads.ts';
import { reportedHistoryResponseSchema } from '../contracts/history.ts';
import { DailyLedgerResponseSchema } from '../contracts/daily-ledger.ts';
import {
  ChartsQuery,
  ArchiveChartsSchema,
  NativeChartsSchema,
  MaturitiesSchema,
} from '../contracts/charts.ts';
const none = z.strictObject({});
const address = z.strictObject({ address: AddressSchema });
export const jsonRevalidation = new Set([
  'home',
  'daily',
  'markets',
  'stakes',
  'holders',
  'calculator',
  'downloads',
  'archiveCharts',
  'nativeCharts',
  'maturities',
]);
export const routes = [
  {
    id: 'archiveCharts',
    path: '/api/v2/charts/archive',
    query: ChartsQuery,
    params: none,
    response: ArchiveChartsSchema,
  },
  {
    id: 'nativeCharts',
    path: '/api/v2/charts/native',
    query: ChartsQuery,
    params: none,
    response: NativeChartsSchema,
  },
  {
    id: 'maturities',
    path: '/api/v2/charts/maturities',
    query: ChartsQuery,
    params: none,
    response: MaturitiesSchema,
  },
  {
    id: 'live',
    path: '/health/live',
    query: none,
    params: none,
    response: z.strictObject({
      status: z.literal('live'),
      mode: z.enum(['development', 'production']),
    }),
  },
  {
    id: 'ready',
    path: '/health/ready',
    query: none,
    params: none,
    response: z.strictObject({ status: z.literal('ready') }),
  },
  {
    id: 'status',
    path: '/api/v2/status',
    query: ChainQuery,
    params: none,
    response: StatusResponseSchema,
  },
  {
    id: 'home',
    path: '/api/v2/home',
    query: ChainQuery,
    params: none,
    response: HomeResponseSchema,
  },
  {
    id: 'daily',
    path: '/api/v2/daily',
    query: DailyQuery,
    params: none,
    response: z.union([DailyResponseSchema, reportedHistoryResponseSchema, DailyLedgerResponseSchema]),
  },
  {
    id: 'markets',
    path: '/api/v2/markets/daily',
    query: MarketQuery,
    params: none,
    response: MarketResponseSchema,
  },
  {
    id: 'stakes',
    path: '/api/v2/stakes',
    query: z.union([StakesQuery, SourceStakesQuery]),
    params: none,
    response: z.union([StakesResponseSchema, SavedStakesResponseSchema]),
  },
  {
    id: 'stakeEvents',
    path: '/api/v2/stake-events',
    query: StakeEventsQuery,
    params: none,
    response: StakeEventsResponseSchema,
  },
  {
    id: 'stake',
    path: '/api/v2/stakes/:id',
    query: z.union([StakeQuery, SourceStakeQuery]),
    params: z.strictObject({ id: StakeIdSchema }),
    response: z.union([StakeResponseSchema, SavedStakeResponseSchema]),
  },
  {
    id: 'address',
    path: '/api/v2/addresses/:address',
    query: z.union([AddressQuery, SourceAddressQuery]),
    params: address,
    response: z.union([AddressResultSchema, SavedAddressResponseSchema]),
  },
  {
    id: 'addressStakes',
    path: '/api/v2/addresses/:address/stakes',
    query: z.union([AddressQuery, SourceAddressQuery]),
    params: address,
    response: z.union([AddressResultSchema, SavedAddressResponseSchema]),
  },
  {
    id: 'holders',
    path: '/api/v2/holders',
    query: z.union([HoldersQuery, SourceHoldersQuery]),
    params: none,
    response: z.union([HoldersResponseSchema, SavedHoldersResponseSchema]),
  },
  {
    id: 'calculator',
    path: '/api/v2/calculator/inputs',
    query: ChainQuery,
    params: none,
    response: CalculatorResponseSchema,
  },
  {
    id: 'downloads',
    path: '/api/v2/downloads',
    query: ChainQuery,
    params: none,
    response: DownloadsResponseSchema,
  },
  {
    id: 'download',
    path: '/api/v2/downloads/:bundle/:dataset',
    query: none,
    params: z.strictObject({
      bundle: z
        .string()
        .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      dataset: z.enum(['daily', 'stakes', 'holders', 'maturities', 'markets']),
    }),
    response: null,
  },
] as const;
