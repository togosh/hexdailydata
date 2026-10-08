import {
  SavedHoldersResponseSchema,
  SavedStakesResponseSchema,
  SavedStakeResponseSchema,
  SavedAddressResponseSchema,
} from '../contracts/source-update.ts';
import {
  SourceStakesQuery,
  SourceStakeQuery,
  SourceStakesResponseSchema,
  SourceStakeResponseSchema,
} from '../contracts/source-stakes.ts';
import { SourceAddressQuery, SourceAddressResponseSchema } from '../contracts/source-address.ts';
import { SourceHoldersQuery, SourceHoldersResponseSchema } from '../contracts/source-holders.ts';
import { StakeEventsQuery, StakeEventsResponseSchema } from '../contracts/stake-events.ts';
import { z } from 'zod';
import {
  ProductQuery,
  ProductLatestQuery,
  ProductPageQuery,
  ProductLookupQuery,
  ProductStakeQuery,
  ProductDailyResponseSchema,
  ProductLiveResponseSchema,
  ProductHomeResponseSchema,
  ProductDownloadsSchema,
} from '../contracts/product-daily.ts';
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
  'latest',
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
    id: 'latest',
    path: '/api/v2/live',
    query: ProductLatestQuery,
    params: none,
    response: ProductLiveResponseSchema,
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
    query: ProductLatestQuery,
    params: none,
    response: ProductHomeResponseSchema,
  },
  {
    id: 'daily',
    path: '/api/v2/daily',
    query: ProductQuery,
    params: none,
    response: ProductDailyResponseSchema,
  },
  {
    id: 'markets',
    path: '/api/v2/markets/daily',
    query: ProductQuery,
    params: none,
    response: ProductDailyResponseSchema,
  },
  {
    id: 'stakes',
    path: '/api/v2/stakes',
    query: ProductLookupQuery,
    params: none,
    response: SavedStakesResponseSchema,
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
    query: ProductStakeQuery,
    params: z.strictObject({ id: StakeIdSchema }),
    response: SavedStakeResponseSchema,
  },
  {
    id: 'address',
    path: '/api/v2/addresses/:address',
    query: ProductPageQuery,
    params: address,
    response: SavedAddressResponseSchema,
  },
  {
    id: 'addressStakes',
    path: '/api/v2/addresses/:address/stakes',
    query: ProductPageQuery,
    params: address,
    response: SavedAddressResponseSchema,
  },
  {
    id: 'holders',
    path: '/api/v2/holders',
    query: ProductPageQuery,
    params: none,
    response: SavedHoldersResponseSchema,
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
    query: ProductLatestQuery,
    params: none,
    response: ProductDownloadsSchema,
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
