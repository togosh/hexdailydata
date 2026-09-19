import { historyMapping } from '../../src/contracts/history.ts';
import { sha256 } from '../../src/worker/history/input.ts';

export const rawRow = (day, overrides = {}) => ({
  currentDay: String(day),
  date: new Date(Date.parse('2019-12-03') + day * 86400000 + 15000).toISOString(),
  circulatingHEX: '900719925474099312345678.12345678901234567890123456789',
  stakedHEX: '100.01',
  stakedHEXGA: '0',
  totalHEX: '999',
  tshareRateHEX: '30000.123',
  totalTshares: '17.0000000000000000000000001',
  dailyPayoutHEX: '10',
  payoutPerTshareHEX: '0.123',
  averageStakeLength: '8.5',
  penaltiesHEX: '0',
  stakedHEXPercent: '40',
  currentHolders: '9007199254740993',
  numberOfHolders: '9007199254740994',
  currentStakerCount: '10',
  totalStakerCount: '20',
  totalTsharesChange: '-1.00000000000000000000000001',
  currentHoldersChange: '-1',
  stakedSupplyChange: '-21',
  circulatingSupplyChange: '0',
  pricePulseX: '1.2300e-40',
  priceUV2: '0.99',
  priceUV2UV3: '0.98',
  priceChangePulseX: '100',
  roiMultiplierFromATL: '999',
  ...overrides,
});
export function selection(bytes, overrides = {}) {
  return {
    source: 'hexdailystats',
    chainId: 369,
    mappingVersion: historyMapping,
    sha256: sha256(bytes),
    fromSourceDay: 1255,
    toSourceDay: 1300,
    fromDate: '2023-05-11',
    toDate: '2023-06-25',
    excludeSourceDays: [],
    excludePriceSourceDays: [],
    provenance: {
      kind: 'synthetic-fixture',
      chainId: 369,
      acquiredAt: '2026-09-19T00:00:00.000Z',
      url: null,
      statement: 'Explicit synthetic offline test fixture; never a real market observation.',
    },
    ...overrides,
  };
}
export function sample() {
  const rows = [
    rawRow(1255),
    rawRow(1258, { pricePulseX: null }),
    rawRow(1259, { pricePulseX: '0' }),
    rawRow(1260, { pricePulseX: '-1' }),
    rawRow(1261),
    rawRow(1262, { pricePulseX: undefined }),
    rawRow(1263),
    rawRow(1264, { pricePulseX: '0.98' }),
    rawRow(1265, { circulatingHEX: '0', stakedHEX: '0', tshareRateHEX: '0', totalTshares: '0' }),
  ];
  // Literal unquoted JSON numbers witness lossless parse before any Number conversion.
  return Buffer.from(
    JSON.stringify(rows.reverse())
      .replaceAll('"9007199254740993"', '9007199254740993')
      .replaceAll('"1.2300e-40"', '1.2300e-40'),
  );
}
