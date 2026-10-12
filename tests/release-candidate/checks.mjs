import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, cp, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import {
  buildRelease,
  verifyRelease,
  checkDependencies,
  verifyDataSelection,
} from "../../build/release-candidate.mjs";
const T = resolve(process.env.HDD_TASK_ROOT);
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("synthetic selection headers reject wrong current/rollback/pair without opening bases", async () => {
  const root = join(T, "fixtures", "selection-headers-" + Date.now());
  await mkdir(join(root, "product"), { recursive: true });
  await mkdir(join(root, "participants"));
  const profile = join(root, "profile.json");
  await writeFile(
    profile,
    JSON.stringify({
      productRoot: join(root, "product"),
      participantRoot: join(root, "participants"),
    }),
  );
  const current = { version: "a".repeat(64), manifestSha256: "b".repeat(64) };
  const rollback = { version: "c".repeat(64), manifestSha256: "d".repeat(64) };
  const participant = {
    generation: "e".repeat(64),
    descriptorSha256: "f".repeat(64),
    product: current,
  };
  const expected = { selectedSequence: 131, current, rollback, participant };
  const state = { sequence: 131, current, rollback };
  await writeFile(join(root, "product/CURRENT.json"), JSON.stringify(current));
  await writeFile(
    join(root, "participants/CURRENT.json"),
    JSON.stringify(participant),
  );
  await writeFile(join(root, "product/STORAGE.json"), JSON.stringify(state));
  assert.equal(
    (await verifyDataSelection(profile, expected)).status,
    "SELECTION_HEADERS_MATCH",
  );
  for (const changed of [
    { ...expected, selectedSequence: 130 },
    { ...expected, current: rollback },
    { ...expected, rollback: current },
    {
      ...expected,
      participant: { ...participant, generation: "0".repeat(64) },
    },
  ])
    await assert.rejects(
      verifyDataSelection(profile, changed),
      /RELEASE_DATA_SELECTION/,
    );
  console.log(
    JSON.stringify({
      syntheticOnly: true,
      selectionRefusals: 4,
      baseAdmissions: 0,
    }),
  );
});

test("cheap source/path/dependency checks refuse before creating an artifact or opening bases", async () => {
  const root = join(T, "fixtures", "release-cheap-" + Date.now());
  await mkdir(root, { recursive: true });
  const mapFile = join(root, "map.json"),
    profileFile = join(root, "profile.json"),
    planFile = join(root, "plan.json");
  await writeFile(profileFile, "{}");
  async function plan(entries) {
    const b = Buffer.from(JSON.stringify(entries));
    await writeFile(mapFile, b);
    await writeFile(
      planFile,
      JSON.stringify({
        sourceRoot: root,
        sourceMapFile: mapFile,
        sourceMapSha256: sha(b),
        outputRoot: join(root, "artifact"),
        dependencyRoot: root,
        profileFile,
      }),
    );
  }
  for (const path of [
    "../private",
    ".npmrc",
    ".env",
    "src/.env.local",
    "node_modules/a",
    "/absolute",
  ]) {
    await plan([{ path, bytes: 0, sha256: "0".repeat(64) }]);
    await assert.rejects(buildRelease(planFile), /RELEASE_PUBLIC_MEMBER/);
  }
  await writeFile(join(root, "public.txt"), "original");
  await plan([{ path: "public.txt", bytes: 8, sha256: "0".repeat(64) }]);
  await assert.rejects(buildRelease(planFile), /RELEASE_SOURCE_IDENTITY/);
  await assert.rejects(
    buildRelease("https://not-a-local-plan"),
    /RELEASE_LOCAL_PATH/,
  );
  const absent = await import("node:fs/promises").then((fs) =>
    fs.stat(join(root, "artifact")).then(
      () => false,
      (e) => e.code === "ENOENT",
    ),
  );
  assert.equal(absent, true);
  const repo = resolve(import.meta.dirname, "../..");
  const inventory = await checkDependencies(repo, repo);
  assert(inventory.packages > 0);
  assert.equal(inventory.portable, false);
  console.log(
    JSON.stringify({
      syntheticOnly: true,
      inventory,
      baseAdmissions: 0,
      externalRequests: 0,
    }),
  );
});

test(
  "exact built payload and profile refusal gates, without serving or base admission",
  { skip: !process.env.HDD_RELEASE_ARTIFACT },
  async () => {
    const root = resolve(process.env.HDD_RELEASE_ARTIFACT),
      profile = resolve(process.env.HDD_RELEASE_PROFILE);
    const manifest = await readFile(join(root, "RELEASE_MANIFEST.json")),
      identity = sha(manifest);
    const positive = await verifyRelease(root, identity, profile);
    assert.equal(positive.status, "VERIFIED");
    await assert.rejects(
      verifyRelease(root, "0".repeat(64), profile),
      /RELEASE_MANIFEST_IDENTITY/,
    );
    const alternate = join(T, "fixtures", "different-profile.json");
    await writeFile(alternate, await readFile(profile));
    await assert.rejects(
      verifyRelease(root, identity, alternate),
      /RELEASE_PROFILE_IDENTITY/,
    );
    const copy = join(T, "fixtures", "artifact-negatives-" + Date.now());
    await mkdir(copy);
    const m = JSON.parse(manifest);
    for (const r of m.files) {
      await mkdir(resolve(copy, r.path, ".."), { recursive: true });
      await cp(join(root, r.path), join(copy, r.path));
    }
    await writeFile(join(copy, "RELEASE_MANIFEST.json"), manifest);
    // Mutations affect this isolated artifact copy only, and refuse before dependencies/profile/base opens.
    const paths = [
      "dist/api/samples/MANIFEST.json",
      "dist/api/samples/daily.csv",
      "dist/api/samples/stakes.csv",
      "dist/api/samples/holders.csv",
      "dist/api/samples/maturities.csv",
      "dist/api/samples/markets.csv",
      "dist/api/main.js",
      "dist/web/index.html",
      "dist/web/openapi.json",
      "SOURCE_MAP.json",
    ];
    for (const name of paths) {
      const p = join(copy, name),
        b = await readFile(p);
      await unlink(p);
      await assert.rejects(verifyRelease(copy, identity, profile));
      await writeFile(p, "corrupt");
      await assert.rejects(
        verifyRelease(copy, identity, profile),
        /RELEASE_ARTIFACT_IDENTITY/,
      );
      await writeFile(p, b);
    }
    await writeFile(join(copy, "dist/unexpected.js"), "not admitted");
    await assert.rejects(
      verifyRelease(copy, identity, profile),
      /RELEASE_UNEXPECTED_ASSET/,
    );
    console.log(
      JSON.stringify({
        syntheticOnly: true,
        negativeMutations: paths.length * 2 + 3,
        baseAdmissions: 0,
        externalRequests: 0,
      }),
    );
  },
);
