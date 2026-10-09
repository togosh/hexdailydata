// Local-only diagnosis. Retains failed fixture locks and never invokes a collector.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
import { deriveFixture } from './fixture-state.mjs';
const R = process.env.HDD_TASK_ROOT;
const name = `restore-diagnostic-${Date.now()}`;
const result = { synthetic: true, externalRequests: 0, root: join(R, 'temp', name) };
let deps, fixture;
try {
  const profile = JSON.parse(await readFile(join(R, 'PROFILE.json')));
  profile.productRoot = join(R, 'restored-candidate/product');
  profile.participantRoot = join(R, 'restored-candidate/participants');
  deps = await openProductDependencies(profile);
  fixture = await deriveFixture(deps.participants, result.root, deps.sourceGenerations);
  const failed = join(R, 'temp/restore-synthetic/participants');
  const intent = JSON.parse(await readFile(join(failed, 'INTENT.json')));
  const update = JSON.parse(await readFile(join(failed, intent.generation, 'UPDATE.json')));
  const proof = JSON.parse(await readFile(join(failed, intent.generation, 'PROOF.json')));
  const release = fixture.productDaily.releaseWriter.bind(fixture.productDaily);
  fixture.productDaily.releaseWriter = async (...args) => {
    try {
      await release(...args);
    } catch (e) {
      result.releaseError = String(e.stack ?? e);
    }
  };
  result.publication = await fixture.publish(update, proof);
  result.status = 'PASS';
} catch (e) {
  result.status = 'FAIL';
  result.originalError = String(e.stack ?? e);
} finally {
  if (fixture) await fixture.close();
  if (deps) await deps.close();
  result.closed = true;
  await writeFile(join(R, 'evidence', name + '.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    status: result.status,
    originalError: result.originalError,
    releaseError: result.releaseError,
  }),
);
