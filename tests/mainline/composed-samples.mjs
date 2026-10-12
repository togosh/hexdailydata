import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkSamples, root } from '../../build/composed.mjs';
// Task-owned retained synthetic output mutations; no service, account or SQL execution.
test('composed sample outputs reject every missing/corrupt file and over-bound data', () => {
  const base = mkdtempSync(resolve(process.env.HDD_TASK_ROOT, 'composed-samples-'));
  mkdirSync(resolve(base, 'delivery/samples'), {recursive:true});
  mkdirSync(resolve(base, 'dist/api/samples'), {recursive:true});
  const names = ['MANIFEST.json', 'daily.csv', 'stakes.csv', 'holders.csv', 'maturities.csv', 'markets.csv'];
  for (const name of names) for (const area of ['delivery/samples','dist/api/samples'])
    copyFileSync(resolve(root,'delivery/samples',name),resolve(base,area,name));
  assert.deepEqual(checkSamples(base), names);
  for (const name of names) {
    const path = resolve(base,'dist/api/samples',name), bytes=readFileSync(path);
    unlinkSync(path); assert.throws(()=>checkSamples(base), /Missing build input/);
    writeFileSync(path, Buffer.from('injected corruption')); assert.throws(()=>checkSamples(base), /differs/);
    writeFileSync(path, bytes);
  }
  const path=resolve(base,'dist/api/samples/daily.csv'), bytes=readFileSync(path);
  writeFileSync(path,Buffer.alloc(16385)); assert.throws(()=>checkSamples(base), /size bound/);
  writeFileSync(path,bytes); assert.deepEqual(checkSamples(base), names);
});
