import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { canonical, sha } from '../../dist/services/source-update/generation.js';
import { runUnified, main } from '../../scripts/refresh-data.mjs';
import { validateProfile, unifiedAdmission } from '../../scripts/unified-refresh/profile.mjs';
import { publicR3, validatePublicReady } from '../../scripts/unified-refresh/public-profile.mjs';
const {
  root: T,
  task: publicTask,
  profile: publicProfile,
  profileHash: publicProfileHash,
  packetHashes,
} = publicR3;
const packet = Object.fromEntries(
  await Promise.all(Object.keys(packetHashes).map(async (p) => [p, await fs.readFile(join(T, p))])),
);
const profile = JSON.parse(packet['packet/PUBLIC_PROFILE.json']);

test('exact public profile and transport cannot be substituted', async () => {
  assert.equal(validateProfile(profile).jobs.length, 23);
  for (const change of [
    (p) => (p.mode = 'OFFLINE_ONLY'),
    (p) => p.jobs.at(-1).target++,
    (p) => p.jobs[0].bounds.httpAttempts++,
    (p) => p.parent.seconds++,
    (p) => p.jobs.pop(),
  ]) {
    const p = structuredClone(profile);
    change(p);
    assert.throws(() => validateProfile(p));
  }
  const a = {
    unifiedProfileId: publicProfile,
    authorityTaskId: publicTask,
    synthetic: false,
    parentMode: 'OWNER_AUTHORIZED_PUBLIC',
    parentProfileSha256: publicProfileHash,
    parentNonce: 'a'.repeat(64),
    preflightSha256: 'b'.repeat(64),
    family: 'gas',
  };
  assert(unifiedAdmission(a));
  for (const k of ['synthetic', 'authorityTaskId', 'parentNonce', 'preflightSha256', 'parentMode'])
    assert.throws(() => unifiedAdmission({ ...a, [k]: 'SPOOF' }));
  for (const extra of [
    { clock: { mode: 'SYNTHETIC' } },
    {
      spawnChild: () => {
        throw Error('NO SPAWN');
      },
    },
  ])
    await assert.rejects(
      runUnified({ profile, taskRoot: T, onFact: () => {}, ...extra }),
      /PUBLIC_REAL_CLOCK_TRANSPORT_REQUIRED/,
    );
  assert.equal(await main([]), 0);
});

test('actual ready validator binds source, inputs, review, loaded owner and unused admission', async () => {
  const original = { readFile: fs.readFile, lstat: fs.lstat },
    repo = 'C:\\synthetic-source';
  let files,
    spent = false;
  const reset = () => {
    const runtimeFiles = { 'synthetic.mjs': sha('source') },
      inputFiles = { 'fixture.json': sha('input') };
    const plan = { commit: 'a'.repeat(40), runtimeFiles, inputFiles };
    const review = {
      verdict: 'PASS',
      candidateCommit: plan.commit,
      planSha256: sha(JSON.stringify(plan)),
    };
    const ready = {
      status: 'PASS',
      pid: process.pid,
      actualPairedRegistry: true,
      freshProcess: true,
      readyAtUtc: new Date().toISOString(),
      runtimeHash: sha(canonical(runtimeFiles)),
    };
    const pre = {
      taskId: publicTask,
      taskRoot: T,
      verdict: 'PASS',
      synthetic: false,
      profileSha256: publicProfileHash,
      scopeSha256: packetHashes['packet/SCOPE.json'],
      runtimeFiles,
      reviewSha256: sha(JSON.stringify(review)),
      readySha256: sha(JSON.stringify(ready)),
      initialProductVersion: 'v',
      initialManifestSha256: 'm',
      initialGeneration: 'g',
    };
    files = new Map(
      Object.entries({
        ...packet,
        'FROZEN_PLAN.json': JSON.stringify(plan),
        'evidence/PREFLIGHT_REVIEW.json': JSON.stringify(review),
        'evidence/READY.json': JSON.stringify(ready),
        'PREFLIGHT.json': JSON.stringify(pre),
        'fixture.json': 'input',
      }).map(([p, v]) => [join(T, p), Buffer.from(v)]),
    );
    files.set(join(repo, 'synthetic.mjs'), Buffer.from('source'));
    spent = false;
    return {
      taskRoot: T,
      repo,
      preflightPath: join(T, 'PREFLIGHT.json'),
      loadedRuntimeFiles: runtimeFiles,
      registry: {
        productDaily: {
          capture: () => ({
            version: 'v',
            manifestSha256: 'm',
            metadata: { marketStorage: { sequence: 50 } },
          }),
        },
        status: () => ({ generation: 'g' }),
      },
    };
  };
  fs.readFile = async (p) => {
    assert(files.has(p), 'UNEXPECTED_READ:' + p);
    return files.get(p);
  };
  fs.lstat = async () => {
    if (spent) return {};
    throw Object.assign(Error('absent'), { code: 'ENOENT' });
  };
  syncBuiltinESMExports();
  try {
    await validatePublicReady(reset());
    for (const mutate of [
      (a) => (a.taskRoot += '-wrong'),
      (a) => (a.loadedRuntimeFiles = {}),
      () => (spent = true),
      () => files.set(join(repo, 'synthetic.mjs'), Buffer.from('changed')),
      () => files.set(join(T, 'fixture.json'), Buffer.from('changed')),
      () => files.set(join(T, 'packet/SCOPE.json'), Buffer.from('{}')),
      () => files.set(join(T, 'evidence/PREFLIGHT_REVIEW.json'), Buffer.from('{}')),
      () => {
        const r = JSON.parse(files.get(join(T, 'evidence/READY.json')));
        r.readyAtUtc = '2000-01-01T00:00:00Z';
        files.set(join(T, 'evidence/READY.json'), Buffer.from(JSON.stringify(r)));
        const p = JSON.parse(files.get(join(T, 'PREFLIGHT.json')));
        p.readySha256 = sha(JSON.stringify(r));
        files.set(join(T, 'PREFLIGHT.json'), Buffer.from(JSON.stringify(p)));
      },
      (a) => (a.registry.status = () => ({ generation: 'changed' })),
      (a) => {
        const capture = a.registry.productDaily.capture;
        a.registry.productDaily.capture = () => ({
          ...capture(),
          metadata: { marketStorage: { sequence: 49 } },
        });
      },
    ]) {
      const a = reset();
      mutate(a);
      await assert.rejects(validatePublicReady(a));
    }
  } finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
});
