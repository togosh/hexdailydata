import { stakeActivityExamples } from './stake-events-examples.mjs';
// Documentation-only examples. Native fixtures are synthetic; saved source examples retain their explicit historical pin. Never imported by data handlers or the browser.
import { readFileSync } from 'node:fs';
import { metricDefinitions } from '../contracts/history.ts';
import { datasets, definitions } from '../contracts/datasets.ts';
const at = '2023-05-16T00:00:00.000Z';
const hash = '0x' + '1'.repeat(64);
const address = '0x' + '1'.repeat(40);
const uuid = '11111111-1111-4111-8111-111111111111';
const block = { chainId: 369, blockNumber: '17233000', blockHash: hash, blockTimestamp: at };
const cutoff = { asOf: block, revision: '1', finality: 'confirmed', contractDay: 1260 };
const exact = '9007199254740993';
const home = JSON.parse(readFileSync(new URL('./home-example.json', import.meta.url)));
const stake = {
  stakeId: '123',
  address,
  originChainId: 369,
  principalHearts: exact,
  stakeShares: exact,
  startDay: 1259,
  lockedDay: 1260,
  stakedDays: 365,
  maturityDay: 1625,
  status: 'open',
  isAutoStake: false,
  startBlock: '17233000',
  startedAt: at,
  gaDay: null,
  gaBlock: null,
  gaOriginChainId: null,
  goodAccountedAt: null,
  endDay: null,
  endBlock: null,
  endOriginChainId: null,
  endedAt: null,
  payoutHearts: null,
  penaltyHearts: null,
};
const headline = {
  dateUtc: '2023-05-16',
  contractDay: 1260,
  displayDay: 1261,
  asOf: block,
  stakedPercent: '0',
  weightedStakeLengthDays: null,
  circulatingHex: '90071992.54740993',
  stakedHex: '0',
  holderCount: '1',
  stakerCount: '0',
};
const coverage = { fromDay: 1260, toDay: 1260, expected: 1, count: 1, missingDays: [] };
const missing = { published: null, value: null, availability: 'missing' };
const reported = (value) => ({ published: value, value, availability: 'available' });
const metadata = {
  selection: {
    source: 'hexdailystats',
    chainId: 369,
    mappingVersion: 'hds-pulsechain-record-date-1',
    sha256: '1'.repeat(64),
    fromSourceDay: 1260,
    toSourceDay: 1260,
    fromDate: '2023-05-16',
    toDate: '2023-05-16',
    excludeSourceDays: [],
    excludePriceSourceDays: [],
    provenance: {
      kind: 'synthetic-fixture',
      chainId: 369,
      acquiredAt: at,
      statement: 'Synthetic documentation fixture; not an observation of any real dataset.',
      url: null,
    },
  },
  summary: {
    records: 1,
    prices: 0,
    firstRecordDateUtc: '2023-05-16',
    lastRecordDateUtc: '2023-05-16',
    firstAvailablePrice: null,
  },
  dateBasis: 'sourceRecordDateUtc',
  priceKind: 'source_reported_daily_reference',
  marketPeriod: 'unproved',
  contentSha256: '2'.repeat(64),
};
const history = {
  chain: 'pulsechain',
  chainId: 369,
  source: 'hexdailystats',
  sourceReported: true,
  revision: uuid,
  metadata,
  fieldDefinitions: metricDefinitions,
  coverage: {
    from: '2023-05-16',
    to: '2023-05-16',
    records: 1,
    prices: 0,
    missingRecordDates: [],
    missingPriceDates: ['2023-05-16'],
  },
  items: [
    {
      sourceDay: 1260,
      sourceDayToken: '1260',
      sourceDate: at,
      sourceRecordDateUtc: '2023-05-16',
      marketPeriodUtc: null,
      dateRelationship: 'unproved',
      quality: 'reported',
      metrics: {
        ...Object.fromEntries(Object.keys(metricDefinitions).map((k) => [k, missing])),
        currentHolders: reported(exact),
        totalTsharesChange: reported('-1e-3'),
        penaltiesHEX: reported('0'),
      },
      referencePriceUsd: missing,
    },
  ],
  continuation: null,
};
const indexed = {
  asOf: block,
  finality: 'confirmed',
  liquidHearts: '0',
  accountedHearts: exact,
  stakeCount: '1',
  staking: {
    contractDay: 1260,
    lockedHearts: exact,
    goodAccountedHearts: '0',
    accountedShares: exact,
    openCount: '1',
    goodAccountedCount: '0',
    endedCount: '0',
    firstStakeDay: 1259,
    nextMaturityDay: 1625,
    activity: [{ stakeId: '123', kind: 'start', originChainId: 369, blockNumber: '17233000', at }],
  },
  rankingDay: null,
  rank: null,
};
const partial = { outcome: 'partial', reason: 'synthetic_live_unavailable', indexed, live: null };
const manifestCutoff = {
  blockNumber: '17233000',
  blockHash: '1'.repeat(64),
  blockTime: '1684108800',
  revision: '1',
};
const bundle = {
  id: uuid,
  formatVersion: 1,
  calculationVersion: 'hex-native-1',
  chainId: 369,
  createdAt: at,
  currentIndex: { ...manifestCutoff, finality: 'confirmed' },
  ranking: null,
  dailyCutoff: 1260,
  dailyPayoutBlock: null,
  origins: [{ chainId: 369, fromBlock: '17233000', toBlock: '17233000' }],
  markets: [],
  files: datasets.map((dataset) => ({
    dataset,
    rows: '0',
    bytes: '100',
    sha256: '3'.repeat(64),
    columns: definitions[dataset].columns,
  })),
  slot: 'current',
};
export const responseExamples = {
  stakeEvents: stakeActivityExamples,
  home: { synthetic: home },
  daily: {
    native: {
      chain: 'pulsechain',
      cutoff,
      coverage,
      items: [
        {
          ...headline,
          originChainId: 369,
          circulatingHearts: exact,
          lockedHearts: '0',
          rawShareRate: '100001',
          activity: { newStakes: '0', endedStakes: '0', penaltiesHex: '0' },
          payout: {
            status: 'pending',
            payoutHearts: null,
            stakeShares: null,
            hexPerTShare: null,
            blockNumber: null,
            blockHash: null,
          },
        },
      ],
    },
    sourceReported: history,
  },
  markets: {
    synthetic: {
      chain: 'pulsechain',
      sources: [
        {
          source: 'synthetic',
          method: 'sampled-ohlc',
          qualification: 'peg_assumed',
          fromDay: 1260,
          throughDay: null,
          dirtyDay: null,
          version: '1',
          captureStatus: 'ready',
        },
      ],
      items: [
        {
          source: 'synthetic',
          contractDay: 1260,
          displayDay: 1261,
          dateUtc: '2023-05-16',
          state: 'accepted',
          observation: {
            open: null,
            high: null,
            low: null,
            close: null,
            volume: null,
            liquidity: null,
            intervals: 0,
            expectedIntervals: 1440,
            coverage: 'missing',
            sourceTime: null,
            observedTime: null,
            blockNumber: null,
            blockHash: null,
            poolTime: null,
          },
        },
      ],
      coverage: [{ ...coverage, source: 'synthetic' }],
    },
  },
  stakes: { synthetic: { chain: 'pulsechain', cutoff, items: [stake], nextCursor: null } },
  stake: {
    synthetic: {
      chain: 'pulsechain',
      cutoff,
      indexed: stake,
      recent: {
        outcome: 'unavailable',
        live: null,
        observation: null,
        observedAt: null,
        expiresAt: null,
        finality: 'provisional',
      },
    },
  },
  holders: {
    synthetic: {
      chain: 'pulsechain',
      cutoff,
      rankAsOf: block,
      rankingDay: 1260,
      order: 'liquid',
      items: [
        {
          address,
          liquidHearts: '0',
          accountedHearts: exact,
          stakeCount: '1',
          liquidRank: null,
          stakerRank: '1',
        },
      ],
      nextCursor: null,
    },
  },
  address: { partial },
  addressStakes: { partial },
  calculator: {
    synthetic: {
      chain: 'pulsechain',
      calculationVersion: 'hex-native-1',
      shareRate: home.live.shareRate,
      presets: [1, 30, 365].map((window) => ({
        window,
        fromDay: null,
        toDay: null,
        count: 0,
        status: 'unavailable',
        reason: 'missing_days',
        value: null,
      })),
    },
  },
  downloads: { synthetic: { status: 'available', bundles: [bundle] } },
  nativeCharts: {
    synthetic: {
      chain: 'pulsechain',
      source: 'native',
      cutoff,
      truncated: false,
      items: [
        {
          day: 1260,
          date: '2023-05-16',
          originChainId: 369,
          values: [null, '10000.1', '0', null, null, '0', '90071992.54740993', '1', '0', '0', '0'],
        },
      ],
    },
  },
  archiveCharts: {
    synthetic: {
      chain: 'pulsechain',
      source: 'hexdailystats',
      revision: uuid,
      metadata,
      items: [
        {
          day: 1260,
          date: '2023-05-16',
          values: [null, null, null, null, '0', null, null, null, null, '0', exact],
        },
      ],
    },
  },
  maturities: {
    synthetic: {
      chain: 'pulsechain',
      cutoff,
      items: [
        { day: 1625, date: '2024-05-15', principalHearts: exact, stakeShares: exact, count: '1' },
      ],
    },
  },
  status: {
    synthetic: {
      mode: 'development',
      chain: 'pulsechain',
      state: 'uninitialized',
      productionReady: false,
      chainSyncImplemented: true,
      liveProvidersEnabled: false,
      database: 'unconfigured',
      qualification: 'offline_only_live_not_qualified',
      streams: [],
      observations: [],
      markets: [],
    },
  },
  live: { synthetic: { status: 'live', mode: 'development' } },
  ready: { synthetic: { status: 'ready' } },
};
export const savedStakeExamples = JSON.parse(readFileSync(new URL('./source-stakes-examples.json', import.meta.url)));
for (const [id, value] of Object.entries(savedStakeExamples.responses)) responseExamples[id].savedSubgraph = value;
export const savedHolderExamples = JSON.parse(readFileSync(new URL('./source-holders-examples.json', import.meta.url)));
responseExamples.holders.savedSubgraph = savedHolderExamples.response;
export const savedUpdateExamples = JSON.parse(readFileSync(new URL('./source-update-examples.json', import.meta.url)));
for (const [id, value] of Object.entries(savedUpdateExamples.responses)) responseExamples[id].savedUpdate = value;
export const errors = {
  401: { code: 'invalid_key', message: 'A valid API key is required.', retryable: false },
  403: { code: 'developer_access_required', message: 'This selection requires an active API key. See /api.', retryable: false },
  400: { code: 'invalid_request', message: 'Invalid request.', retryable: false },
  405: { code: 'read_only', message: 'Only read requests are supported.', retryable: false },
  409: {
    code: 'cursor_incompatible',
    message: 'Observation changed or expired; restart pagination.',
    retryable: false,
  },
  410: { code: 'bundle_retired', message: 'This immutable bundle is retired.', retryable: false },
  429: { code: 'http_quota', message: 'HTTP admission limit reached.', retryable: true },
  503: { code: 'source_unavailable', message: 'Required data is unavailable.', retryable: true },
};
