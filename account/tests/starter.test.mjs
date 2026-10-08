import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  setup,
  rootCheck,
  verifyPristine,
  preflight,
  packageSource,
  git,
  WORKSPACE,
  digest,
} from "../tools/lab.mjs";
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t, space = false) {
  const base = os.tmpdir();
  const temp = fs.mkdtempSync(
    path.join(base, space ? "hdd paid starter " : "hdd-paid-starter-"),
  );
  const root = path.join(temp, WORKSPACE);
  fs.mkdirSync(root);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, "STARTER_FILES.json"), "utf8"),
  );
  for (const rel of [
    ...manifest.files.map((x) => x.path),
    "STARTER_FILES.json",
  ]) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source, rel), dest);
  }
  manifest.files = manifest.files.map((e) => {
    const bytes = fs.readFileSync(path.join(root, e.path));
    return { ...e, bytes: bytes.length, sha256: digest(bytes) };
  });
  fs.writeFileSync(
    path.join(root, "STARTER_FILES.json"),
    JSON.stringify(manifest),
  );
  // These fresh test directories are owned by this test. Never use this on user paths.
  t.after(() => {
    const target = path.resolve(temp);
    if (
      !target.startsWith(path.resolve(base) + path.sep) ||
      !/^hdd[ -]paid[ -]starter[ -]/.test(path.basename(target))
    )
      throw Error("CLEANUP_BOUNDARY");
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { root, temp };
}
test("pristine boundary manifest verifies", (t) => {
  const { root } = fixture(t);
  assert.ok(verifyPristine(root).includes("CODEX_PROMPT.txt"));
});
test("fresh setup creates its own main repo and nonsecret identity", (t) => {
  const { root } = fixture(t);
  const r = setup(root);
  assert.equal(r.status, "LAB_REPOSITORY_READY");
  assert.equal(r.alreadyInitialized, false);
  assert.equal(git(root, ["branch", "--show-current"]), "main");
  assert.equal(git(root, ["status", "--porcelain"]), "");
});
test("spaces in the lab path supported", (t) => {
  const { root } = fixture(t, true);
  assert.equal(setup(root).status, "LAB_REPOSITORY_READY");
});
test("repeat setup preserves edited source and initial commit", (t) => {
  const { root } = fixture(t);
  setup(root);
  const sha = git(root, ["rev-parse", "HEAD"]);
  fs.appendFileSync(path.join(root, "README.md"), "LOCAL WORK\n");
  assert.equal(setup(root).alreadyInitialized, true);
  assert.equal(git(root, ["rev-parse", "HEAD"]), sha);
  assert.ok(
    fs
      .readFileSync(path.join(root, "README.md"), "utf8")
      .endsWith("LOCAL WORK\n"),
  );
});
test("wrong workspace name refused", (t) => {
  const { root, temp } = fixture(t);
  const renamed = path.join(temp, "HEXDailyData-v2");
  fs.renameSync(root, renamed);
  assert.throws(() => rootCheck(renamed), /Expected standalone/);
});
test("ancestor git refused without opening it", (t) => {
  const { root, temp } = fixture(t);
  fs.mkdirSync(path.join(temp, ".git"));
  assert.throws(() => setup(root), /nested Git/);
  assert.ok(!fs.existsSync(path.join(root, ".git")));
});
test("wrong marker refused", (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, ".lab-starter.json"), "{}");
  assert.throws(() => setup(root), /Wrong lab marker/);
});
test("modified fresh starter refused without writes", (t) => {
  const { root } = fixture(t);
  fs.appendFileSync(path.join(root, "README.md"), "local");
  assert.throws(() => setup(root), /Starter differs/);
  assert.ok(!fs.existsSync(path.join(root, ".git")));
});
test("extra existing file refused and preserved", (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "progress.txt"), "keep");
  assert.throws(() => setup(root), /Not a pristine/);
  assert.equal(
    fs.readFileSync(path.join(root, "progress.txt"), "utf8"),
    "keep",
  );
});
test("existing unmanaged repo refused", (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  assert.throws(() => setup(root), /Partial\/unrecognized/);
});
test("partial initialization refused without reset", (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, ".local"));
  assert.throws(() => setup(root), /Partial\/unrecognized/);
  assert.ok(!fs.existsSync(path.join(root, ".git")));
});
test("linked root refused", (t) => {
  const { root, temp } = fixture(t);
  const real = path.join(temp, "real");
  fs.renameSync(root, real);
  fs.symlinkSync(real, root, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => setup(root), /non-ordinary/);
});
test(
  "linked payload refused",
  {
    skip:
      process.platform === "win32"
        ? "Windows file symlink privilege unavailable"
        : false,
  },
  (t) => {
    const { root, temp } = fixture(t);
    const f = path.join(root, "README.md"),
      out = path.join(temp, "readme");
    fs.renameSync(f, out);
    fs.symlinkSync(out, f);
    assert.throws(() => setup(root), /Symlink refused/);
  },
);
test("linked ancestor refused", (t) => {
  const { root, temp } = fixture(t);
  const alias = path.join(temp, "alias");
  fs.symlinkSync(
    temp,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => setup(path.join(alias, WORKSPACE)), /non-ordinary/);
});
test("corrupt local identity refused", (t) => {
  const { root } = fixture(t);
  setup(root);
  fs.writeFileSync(path.join(root, ".local", "lab.json"), "{}");
  assert.throws(() => setup(root), /identity mismatch/);
});
test("preflight reports boundary only", (t) => {
  const { root } = fixture(t);
  setup(root);
  const r = preflight(root);
  assert.equal(r.status, "LAB_BOUNDARY_READY");
  assert.match(r.note, /No DB/);
});
test("inherited GIT_DIR cannot redirect setup", (t) => {
  const { root, temp } = fixture(t);
  const old = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(temp, "forbidden");
  try {
    setup(root);
    assert.ok(fs.existsSync(path.join(root, ".git")));
    assert.ok(!fs.existsSync(path.join(temp, "forbidden")));
  } finally {
    if (old === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = old;
  }
});
test("committed source package excludes ignored runtime paths", (t) => {
  const { root } = fixture(t);
  setup(root);
  fs.writeFileSync(path.join(root, ".local", "secret.txt"), "SYNTHETICSECRET");
  const r = packageSource(root),
    b = fs.readFileSync(r.path);
  assert.equal(r.sha256, digest(b));
  assert.equal(b.readUInt32LE(0), 0x04034b50);
  assert.equal(git(root, ["status", "--porcelain"]), "");
  assert.ok(!git(root, ["ls-files"]).includes(".local/secret"));
});
test("dirty source not silently packaged", (t) => {
  const { root } = fixture(t);
  setup(root);
  fs.appendFileSync(path.join(root, "README.md"), "change");
  assert.throws(() => packageSource(root), /Commit reviewed/);
});
test("tracked .env refused during packaging", (t) => {
  const { root } = fixture(t);
  setup(root);
  fs.writeFileSync(path.join(root, ".env"), "synthetic");
  git(root, ["add", "-f", "--", ".env"]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "synthetic negative fixture",
  ]);
  assert.throws(() => packageSource(root), /secret path/);
});
test("application stubs fail rather than claim PASS", () => {
  const r = spawnSync(
    process.execPath,
    [path.join(source, "tools/not-implemented.mjs")],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /LAB_APPLICATION_NOT_IMPLEMENTED/);
});
