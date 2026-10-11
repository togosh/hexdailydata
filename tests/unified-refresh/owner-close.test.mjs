import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closePublicResources } from '../../scripts/unified-refresh/owner.mjs';
test('actual owner always closes bases and never passes incomplete finalization', async () => {
  for (const mode of [
    'success',
    'base-unknown',
    'restore-report-failure',
    'application-throw',
    'no-final-proof',
  ]) {
    let calls = 0;
    const result = await closePublicResources({
      shouldRestore: mode !== 'no-final-proof',
      closeApplication: async () => {
        if (mode === 'application-throw') throw Error('synthetic application close');
        return { known: true };
      },
      restore: async () => {
        if (mode === 'restore-report-failure') throw Error('synthetic restore');
      },
      reportFailure: async () => {
        throw Error('synthetic evidence write');
      },
      closeBase: async () => {
        calls++;
        return { known: mode !== 'base-unknown' };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, ['success', 'no-final-proof'].includes(mode));
  }
});
