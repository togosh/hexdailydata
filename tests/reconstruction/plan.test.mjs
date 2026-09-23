import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  reconstructionPlanSchema,
  reconstructionAuthority,
} from '../../dist/operator/reconstruction-plan.js';
import { runReconstruction } from '../../dist/operator/reconstruction.js';
const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const example = await json('../../config/reconstruction.synthetic.example.json');
const profile = await json('./observed-profile.json');
const admission = await json('./observed-admission.json');
// Exact saved profile/admission, but deliberately synthetic operation/image/root bindings.
// This parser fixture is not an executable approval or a retained database fixture.
const plan = {
  ...example,
  profile,
  admission,
  target: '10000255',
  milestones: ['9100255', '10000255'],
  finalityHeaders: { minimum: profile.target.number, maximum: '100000000' },
};
for (const [label, operators, valid] of [
  ['both unknown', [null, null], true],
  ['first unknown', [null, 'known-b'], true],
  ['second unknown', ['known-a', null], true],
  ['distinct known', ['known-a', 'known-b'], true],
  ['equal known ignoring case', ['Known-A', 'known-a'], false],
])
  test(label, () => {
    const p = structuredClone(plan);
    operators.forEach((value, i) => (p.profile.ethereum[i].operator = value));
    assert.equal(reconstructionPlanSchema.safeParse(p).success, valid);
  });
for (const key of ['id', 'endpointEnv'])
  test('duplicate ' + key, () => {
    const p = structuredClone(plan);
    p.profile.ethereum[1][key] = p.profile.ethereum[0][key];
    assert.equal(reconstructionPlanSchema.safeParse(p).success, false);
  });
test('duplicate and unsafe URLs still refuse', () => {
  for (const endpoints of [
    [plan.endpoints[0], plan.endpoints[0]],
    ['http://a.invalid', plan.endpoints[1]],
    ['https://user:password@a.invalid', plan.endpoints[1]],
    ['https://a.invalid?query=1', plan.endpoints[1]],
    ['https://a.invalid#fragment', plan.endpoints[1]],
  ])
    assert.equal(reconstructionPlanSchema.safeParse({ ...plan, endpoints }).success, false);
});
test('target, admission and authority remain exact', () => {
  for (const change of [
    { target: '9046930', milestones: ['9046930'] },
    { target: '17233000', milestones: ['17233000'] },
    { milestones: ['9100255'] },
    { admission: { ...admission, sourceBindingDigest: 'f'.repeat(64) } },
    { admission: { ...admission, counts: { ...admission.counts, accounts: '0' } } },
  ])
    assert.equal(reconstructionPlanSchema.safeParse({ ...plan, ...change }).success, false);
  assert.throws(() => reconstructionAuthority(reconstructionPlanSchema.parse(plan), null, {}));
});
test('exact saved profile/admission check never constructs transport or accesses SQL', async () => {
  const root = new URL(
    '../../artifacts/task-10/bulk-preparation/tests/parser-' + randomUUID() + '/',
    import.meta.url,
  );
  await mkdir(root, { recursive: true });
  let constructions = 0;
  try {
    const path = new URL('plan.json', root);
    await writeFile(path, JSON.stringify(plan));
    const { fileURLToPath } = await import('node:url');
    const result = await runReconstruction(
      ['check', fileURLToPath(path)],
      new AbortController().signal,
      {
        env: {},
        transport: () => {
          constructions++;
          throw Error('Transport forbidden');
        },
      },
    );
    assert.equal(result.authorization, 'NOT_AUTHORIZED');
    assert.equal(constructions, 0);
    assert.deepEqual(reconstructionPlanSchema.parse(plan).profile, profile);
    assert.deepEqual(reconstructionPlanSchema.parse(plan).admission, admission);
  } finally {
    await rm(root, { recursive: true });
  }
});
