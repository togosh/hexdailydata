import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { routes } from '../../src/api/routes.ts';
import { connect, databaseConfig } from '../../src/db/connect.ts';
import { ExportService } from '../../src/worker/exports/service.ts';
const base = 'http://api:4320';
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(base + '/health/live')).ok) break;
  } catch {}
  await pause(250);
}
for (const path of [
  '/health/live',
  '/health/ready',
  '/api/v2/status',
  '/api/v2/home',
  '/api/v2/daily?from=2021-01-04&to=2021-01-05',
  '/api/v2/stakes?limit=5',
  '/api/v2/holders?limit=5',
  '/api/v2/downloads',
]) {
  const r = await fetch(base + path);
  assert.equal(r.status, 200, path + ': ' + (await r.clone().text()));
  const route = routes.find((x) => x.path === path.split('?')[0]);
  route.response.parse(await r.json());
  console.log('PASS compiled image', path);
}
assert.match(await (await fetch(base + '/')).text(), /HEXDailyData/);
assert.equal((await fetch(base + '/api/v2/home?chain=ethereum')).status, 503);
console.log('PASS compiled assets and chain separation; no live providers; native API ready');
if (process.argv.includes('--restore')) {
  const before = await (await fetch(base + '/api/v2/downloads')).json();
  assert.equal(before.status, 'rebuilding');
  const worker = await connect(databaseConfig('worker'));
  try {
    const rows = (await worker.query('SELECT id FROM hdd.export_bundles')).rows;
    assert.equal(rows.length, 2);
    for (const r of rows)
      assert.equal(
        (
          await fetch(base + '/api/v2/downloads/' + r.id + '/daily', {
            headers: { 'If-None-Match': '*' },
          })
        ).status,
        503,
      );
    const writer = new ExportService(() => connect(databaseConfig('worker')), '/exports');
    await writer.startup(new AbortController().signal);
    await worker.query(
      "UPDATE hdd.export_bundles SET published_at=now()-interval '61 seconds' WHERE slot='prior'",
    );
    const rebuilt = await writer.build(369, new AbortController().signal);
    assert.ok(rows.every((r) => r.id !== rebuilt.id));
    let catalog;
    for (let i = 0; i < 80; i++) {
      assert.equal((await fetch(base + '/api/v2/home')).status, 200);
      catalog = await (await fetch(base + '/api/v2/downloads')).json();
      if (catalog.bundles.some((b) => b.id === rebuilt.id)) break;
      await pause(100);
    }
    assert.ok(catalog.bundles.some((b) => b.id === rebuilt.id));
    for (const r of rows)
      assert.equal(
        (
          await fetch(base + '/api/v2/downloads/' + r.id + '/daily', {
            headers: { 'If-None-Match': '*' },
          })
        ).status,
        410,
      );
    console.log(
      'PASS fresh DB-only restore; native HTTP stays ready; old IDs never304; new worker publication appears through automatic refresh without API restart',
    );
  } finally {
    await worker.end();
  }
}
