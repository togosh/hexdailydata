import { z } from 'zod';
import { HomeResponseSchema, StatusResponseSchema } from '../contracts/api.ts';
import {
  ChainQuery,
  RangeQuery,
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
]);
export const routes = [
  {
    id: 'live',
    path: '/health/live',
    query: none,
    params: none,
    response: z.strictObject({ status: z.literal('live'), mode: z.literal('development') }),
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
    query: RangeQuery,
    params: none,
    response: DailyResponseSchema,
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
    query: StakesQuery,
    params: none,
    response: StakesResponseSchema,
  },
  {
    id: 'stake',
    path: '/api/v2/stakes/:id',
    query: StakeQuery,
    params: z.strictObject({ id: StakeIdSchema }),
    response: StakeResponseSchema,
  },
  {
    id: 'address',
    path: '/api/v2/addresses/:address',
    query: AddressQuery,
    params: address,
    response: AddressResultSchema,
  },
  {
    id: 'addressStakes',
    path: '/api/v2/addresses/:address/stakes',
    query: AddressQuery,
    params: address,
    response: AddressResultSchema,
  },
  {
    id: 'holders',
    path: '/api/v2/holders',
    query: HoldersQuery,
    params: none,
    response: HoldersResponseSchema,
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
