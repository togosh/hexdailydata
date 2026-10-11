// SYNTHETIC ONLY. Production base admission is deliberately not exercised here.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SavedSourceGenerations } from '../../dist/services/source-update/generation.js';
import {
  ParticipantRegistry,
  participantPair,
} from '../../dist/services/source-update/refresh.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { metricKeys } from '../../dist/contracts/product-daily.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { createMarketStorage } from '../../dist/services/product-daily/storage.js';
import { decodeDailyWord } from '../../dist/contracts/protocol-daily.js';

export const now = Date.parse('2026-10-11T12:00:00Z');
export const address = (i) => '0x' + (i + 1).toString(16).padStart(40, '0');
const hash = 'a'.repeat(64);
export function holder(i) {
  return {
    reported: {
      id: address(i),
      numeralIndex: String(i),
      holderAddress: address(i),
      totalSent: '0',
      totalReceived: '123400000000',
      tokenBalance: '123400000000',
      createdTimeStamp: '1791215285',
      createdBlocknumber: '27720851',
      createdHexDay: '2498',
      lastModifiedHexDay: '2498',
      lastModifiedTimeStamp: '1791215285',
    },
    anomaly: null,
    provenance: {
      segment: 'HOLDER_R2',
      sourcePage: 1,
      sourceAttempt: 1,
      rowInPage: i,
      originalPageSha256: hash,
    },
  };
}
export function stake(i) {
  return {
    reported: {
      id: 'synthetic-' + String(i).padStart(4, '0'),
      stakerAddr: address(i),
      stakeId: String(i + 1),
      data0: '0',
      timestamp: '1791215285',
      stakedHearts: '1000000000000',
      stakeShares: '100000000000',
      stakedDays: '365',
      isAutoStake: false,
      stakeTShares: '0.1',
      startDay: '2498',
      endDay: '2863',
      blockNumber: '27720851',
      transactionHash: '0x' + hash,
      stakeEnd: null,
      stakeGoodAccounting: null,
    },
    recordState: 'no_end_or_ga_link',
    provenance: {
      segment: 'R2',
      sourcePage: 1,
      sourceAttempt: 1,
      rowInPage: i,
      originalPageSha256: hash,
    },
    discrepancies: [],
  };
}
export function syntheticBase(root, onClose = () => {}) {
  const bounded = (i, fn) => {
    if (!Number.isInteger(i) || i < 0 || i >= 300) throw Error('SYNTHETIC_ROW_BOUND');
    return fn(i);
  };
  const reader = (name, fn) => ({
    root: join(root, name),
    metrics: { parsedRecords: 0 },
    lowerBound: async () => 0,
    rowAt: async (i) => bounded(i, fn),
    close: async () => onClose(name),
    ownerCount: (a) => (a === address(0) ? 1 : 0),
    ownerAt: async (a, i) => (a === address(0) && i === 0 ? stake(0) : null),
    byNumericId: async (id) => (id === '1' ? stake(0) : null),
    lookup: async (a) => ({
      state: 'present_in_saved_inventory',
      item: a === address(0) ? holder(0) : null,
    }),
  });
  const base = new SavedSourceGenerations(
    join(root, 'overlay'),
    reader('holders', holder),
    reader('stakes', stake),
  );
  base.selected = ACCEPTED.generation;
  base.overlay = {
    holders: new Map(),
    stakes: new Map(),
    addresses: new Map(),
    numeric: new Map(),
    owners: new Map(),
    newHolders: [],
    newStakes: [],
    index: '',
    files: {},
  };
  return base;
}
export function template(pair) {
  const rows = [];
  for (let day = 2133; day <= 2504; day++) {
    const dateUtc = new Date(1575331200000 + day * 86400000).toISOString().slice(0, 10);
    rows.push({
      contractDay: day,
      dateUtc,
      snapshotRecordedAtUtc: null,
      priceRecordedAtUtc: null,
      btcRecordedAtUtc: null,
      ethRecordedAtUtc: null,
      plsRecordedAtUtc: null,
      gasRecordedAtUtc: null,
      liquidityRecordedAtUtc: null,
      priceEra: null,
      ...Object.fromEntries(metricKeys.map((k) => [k, null])),
      ...(day < 2498 ? decodeDailyWord(String(7n + (3n << 72n))) : {}),
    });
  }
  const observedAtUtc = new Date(now).toISOString();
  const globalWords = Array(13).fill('0');
  globalWords[2] = '123456';
  globalWords[4] = '2498';
  globalWords[10] = String(now / 1000);
  const readings = [
    {
      kind: 'protocol',
      chainId: 369,
      blockNumber: 27720852,
      blockHash: '0x' + hash,
      observedAtUtc,
      globalWords,
    },
    {
      kind: 'market',
      asset: 'HEX',
      quote: 'USD',
      observation: 'spot',
      chainId: 369,
      value: '0.01',
      observedAtUtc,
    },
  ];
  Object.assign(rows.at(-1), {
    hexPriceUsd: '0.01',
    priceRecordedAtUtc: observedAtUtc,
    priceEra: 'pulsechain',
  });
  return {
    rows,
    exceptions: [],
    metadata: {
      schemaVersion: 'daily-product-1',
      methodRevision: 'utc-recorded-snapshot-primary-price-1',
      inputHashes: { synthetic: hash },
      pair,
      ledgerObservedAtUtc: '2026-10-05T15:48:05Z',
      from: rows[0].dateUtc,
      through: rows.at(-1).dateUtc,
      rows: rows.length,
      effectiveAtUtc: observedAtUtc,
      readings,
      coverage: {
        snapshotDates: 0,
        ledgerDates: 2498,
        priceDates: 1,
        structuralDates: 0,
        gaps: [],
      },
      priceSegments: [],
      methods: [
        'SYNTHETIC ONLY; 372 tiny rows, fixed compatibility counters are not a census',
      ],
      credits: 'SYNTHETIC test fixture; no genuine data admission',
    },
  };
}
export async function initialize(root) {
  root = resolve(root);
  for (const name of ['overlay', 'holders', 'stakes'])
    await mkdir(join(root, name), { recursive: true });
  const base = syntheticBase(root),
    pair = participantPair(base);
  const store = await createMarketStorage(join(root, 'product'), productFiles(template(pair)));
  const registry = await ParticipantRegistry.initialize(
    join(root, 'participants'),
    store,
    base,
  );
  const profile = {
    productRoot: store.root,
    history: join(root, 'unused-history'),
    historyManifestSha256: hash,
    ledger: join(root, 'unused-ledger'),
    ledgerSha256: hash,
    holdersRoot: base.holders.root,
    stakesRoot: base.stakes.root,
    overlayRoot: base.root,
    participantRoot: registry.root,
    pair,
  };
  await writeFile(join(root, 'profile.json'), JSON.stringify(profile), { flag: 'wx' });
  await writeFile(join(root, 'clock.txt'), String(now), { flag: 'wx' });
  await registry.close();
  await base.close();
  return profile;
}
