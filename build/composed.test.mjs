import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { root, manifest, physical, checkInputs, checkOutputs } from './composed.mjs';

// Real build artifacts are copied into disposable task-local fixtures.
// Mutations below are injected failures, not runtime/payment/SQL tests.
function fixture(t) {
  checkOutputs(root);
  const dir = mkdtempSync(resolve(root, '.build-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of manifest.roots) mkdirSync(resolve(dir, name), { recursive: true });
  const files = new Set([...manifest.requiredInputs,
    ...Object.keys(manifest.sqlAssets).map(name => `account/src/${name}`),
    ...manifest.additionalSqlCopies.map(name => `account/src/${name}`),
    ...Object.values(manifest.sqlAssets).map(name => `account/src/${name}.ts`)]);
  for (const file of files) {
    mkdirSync(dirname(resolve(dir, physical(file))), { recursive: true });
    copyFileSync(resolve(root, physical(file)), resolve(dir, physical(file)));
  }
  for (const name of ['account', 'serving'])
    cpSync(resolve(root, physical(name), 'dist'), resolve(dir, physical(name), 'dist'), { recursive: true });
  return dir;
}

test('real composed build passes the bounded input/asset manifest', () => {
  checkInputs(root);
  assert.deepEqual(checkOutputs(root).roots, ['.', 'account', 'delivery', 'runtime', 'transport']);
});

test('missing OpenAPI generator is rejected before compilation', t => {
  const dir = fixture(t);
  unlinkSync(resolve(dir, 'scripts/openapi.mjs'));
  assert.throws(() => checkInputs(dir), /Missing build input\/asset: serving\/scripts\/openapi.mjs/);
});

test('every required SQL source and compiled asset is checked', t => {
  const dir = fixture(t);
  for (const name of [...Object.keys(manifest.sqlAssets), ...manifest.additionalSqlCopies]) {
    for (const area of ['src', 'dist/server']) {
      const file = resolve(dir, `account/${area}/${name}`), bytes = readFileSync(file);
      unlinkSync(file);
      assert.throws(() => checkOutputs(dir), /Missing build input\/asset/);
      writeFileSync(file, bytes);
    }
  }
  writeFileSync(resolve(dir, 'account/dist/server/payment-budget.sql'), '-- injected wrong asset\n');
  assert.throws(() => checkOutputs(dir), /SQL copy differs: payment-budget.sql/);
});

test('standalone asset base is rejected for composed account output', t => {
  const dir = fixture(t), file = resolve(dir, 'account/dist/ui/index.html');
  const html = readFileSync(file, 'utf8');
  assert.ok(html.includes('/account/assets/'));
  writeFileSync(file, html.replaceAll('/account/assets/', '/assets/'));
  assert.throws(() => checkOutputs(dir), /Wrong account asset base/);
});

test('missing linked account asset and changed emitted OpenAPI are rejected', t => {
  const dir = fixture(t);
  const ref = checkOutputs(dir).assets.account[0];
  const file = resolve(dir, 'account/dist/ui', ref.slice('/account/'.length));
  const bytes = readFileSync(file);
  unlinkSync(file);
  assert.throws(() => checkOutputs(dir), /Missing build input\/asset/);
  writeFileSync(file, bytes);
  writeFileSync(resolve(dir, 'dist/web/openapi.json'), '{}');
  assert.throws(() => checkOutputs(dir), /Emitted OpenAPI differs/);
});

test('missing unchanged runtime module fails the five-root check', t => {
  const dir = fixture(t);
  unlinkSync(resolve(dir, 'runtime/paid-service.mjs'));
  assert.throws(() => checkInputs(dir), /Missing build input\/asset: runtime\/paid-service.mjs/);
});
