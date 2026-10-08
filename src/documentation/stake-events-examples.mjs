// Synthetic contract examples only. These tokens are not valid for a real database.
import { createHash } from 'node:crypto';
const blockHash = '0x' + '1'.repeat(64);
const address = '0x' + '1'.repeat(40);
const cursor = (mode, position) =>
  Buffer.from(
    JSON.stringify({
      v: 1,
      mode,
      instance: '11111111-1111-4111-8111-111111111111',
      binding: '2'.repeat(64),
      selection: createHash('sha256')
        .update(
          JSON.stringify({
            chain: 'pulsechain',
            fromBlock: '0',
            address: null,
            stakeId: null,
            kind: null,
            limit: 50,
          }),
        )
        .digest('hex'),
      upper: { number: '104', hash: blockHash, timestamp: '1576195200', finality: 'confirmed' },
      position,
    }),
  ).toString('base64url');
const response = {
  chain: 'pulsechain',
  coverageStartBlock: '100',
  cutoff: {
    blockNumber: '104',
    blockHash,
    blockTimestamp: '2019-12-13T00:00:00.000Z',
    finality: 'confirmed',
  },
  items: [],
  caughtUp: true,
  scannedEvents: 0,
  nextCursor: cursor('progress', null),
};
export const stakeActivityExamples = {
  lifecycle: {
    ...response,
    scannedEvents: 1,
    items: [
      {
        eventId: `369:${blockHash}:1`,
        originChainId: 369,
        blockNumber: '104',
        blockHash,
        transactionHash: '0x' + '3'.repeat(64),
        transactionIndex: 0,
        logIndex: 1,
        timestamp: response.cutoff.blockTimestamp,
        stakeId: '123',
        address,
        kind: 'stake_start',
        amounts: {
          principalHearts: '900719925474099312345678',
          stakeShares: '900719925474099312345678',
          stakedDays: 365,
          isAutoStake: false,
        },
      },
    ],
  },
  emptyIncomplete: {
    ...response,
    caughtUp: false,
    scannedEvents: 200,
    nextCursor: cursor('page', { block: '103', hash: '0x' + '4'.repeat(64), log: 399 }),
  },
  emptyCaughtUp: response,
};
