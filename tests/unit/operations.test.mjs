import test from 'node:test';
import assert from 'node:assert/strict';
import { backupAge, BackupSchedule } from '../../src/operator/backup.ts';
import { developmentConfig } from '../../src/api/config.ts';
import { createApp } from '../../src/api/app.ts';
const now = Date.parse('2026-09-19T12:00:00Z');
function receipt(age) {
  return {
    sha256: 'a'.repeat(64),
    bytes: 500,
    sourceInstance: 'd467c5ee-7db1-4aca-b1ab-4c8c3bfcce86',
    capturedAt: new Date(now - age).toISOString(),
    verifiedAt: new Date(now).toISOString(),
  };
}
test('backup health measures snapshot age, including the 24h boundary, never upload recency', () => {
  for (const [age, state] of [
    [0, 'healthy'],
    [86399999, 'healthy'],
    [86400000, 'healthy'],
    [86400001, 'stale'],
    [90000000, 'stale'],
    [-1, 'invalid'],
  ])
    assert.equal(backupAge(receipt(age), now).state, state);
  assert.equal(backupAge(null, now).state, 'missing');
  assert.equal(backupAge({ ...receipt(1), capturedAt: 'bad' }, now).state, 'invalid');
  assert.equal(
    backupAge({ ...receipt(1), verifiedAt: new Date(now + 1).toISOString() }, now).state,
    'invalid',
  );
});
test('production mode is configuration, not live access or qualification', async () => {
  assert.equal(developmentConfig({ HDD_V2_MODE: 'production' }).mode, 'production');
  assert.throws(() => developmentConfig({ HDD_V2_MODE: 'unsupported' }));
  const app = createApp({ mode: 'production' });
  try {
    assert.equal((await app.inject('/health/live')).json().mode, 'production');
    const status = (await app.inject('/api/v2/status')).json();
    assert.equal(status.productionReady, false);
    assert.equal(status.liveProvidersEnabled, false);
    assert.equal(status.state, 'uninitialized');
  } finally {
    await app.close();
  }
});
test('unconfigured backup scheduler does no work', async () => {
  await new BackupSchedule({}, () => now).tick(new AbortController().signal);
});
