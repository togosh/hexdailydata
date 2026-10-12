// Host-only serving artifact. No install, updater, SQL composition or data mutation.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, realpath, readdir, symlink } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const hex = /^[0-9a-f]{64}$/;
const ownFile = fileURLToPath(import.meta.url);
function local(p) {
  if (
    typeof p !== 'string' ||
    !isAbsolute(p) ||
    /^(?:\\\\|\/\/)/.test(p) ||
    p.includes('\0') ||
    p.split(/[\\/]/).includes('..')
  )
    throw Error('RELEASE_LOCAL_PATH');
  return resolve(p);
}
function member(p) {
  if (
    typeof p !== 'string' ||
    !p ||
    p.includes('\\') ||
    p.startsWith('/') ||
    p.split('/').some((x) => !x || x === '.' || x === '..') ||
    /(^|\/)(?:\.npmrc|\.env(?:\..*)?|node_modules)(\/|$)/.test(p)
  )
    throw Error('RELEASE_PUBLIC_MEMBER');
  return p;
}
async function exactFile(root, name) {
  const p = join(root, member(name)),
    s = await lstat(p);
  if (!s.isFile() || s.isSymbolicLink() || (await realpath(p)) !== resolve(p))
    throw Error('RELEASE_FILE');
  return readFile(p);
}
async function files(root, prefix = '') {
  const result = [];
  for (const d of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isSymbolicLink()) throw Error('RELEASE_PAYLOAD_LINK');
    if (d.isDirectory()) result.push(...(await files(root, name)));
    else if (d.isFile()) result.push(name);
    else throw Error('RELEASE_PAYLOAD_TYPE');
  }
  return result.sort();
}
async function put(p, bytes) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, bytes, { flag: 'wx' });
}
export async function checkDependencies(sourceRoot, dependencyRoot) {
  sourceRoot = local(sourceRoot);
  dependencyRoot = local(dependencyRoot);
  const lockBytes = await exactFile(sourceRoot, 'package-lock.json');
  if (!lockBytes.equals(await exactFile(dependencyRoot, 'package-lock.json')))
    throw Error('RELEASE_DEPENDENCY_LOCK');
  const lock = JSON.parse(lockBytes),
    installedBytes = await readFile(join(dependencyRoot, 'node_modules/.package-lock.json'));
  const installed = JSON.parse(installedBytes);
  let packages = 0;
  for (const [path, info] of Object.entries(installed.packages)) {
    const expected = lock.packages[path];
    if (
      !path.startsWith('node_modules/') ||
      path.split('/').includes('..') ||
      !expected ||
      info.link ||
      ['version', 'integrity', 'resolved'].some((k) => info[k] !== expected[k])
    )
      throw Error('RELEASE_INSTALLED_INVENTORY');
    if ((await json(join(dependencyRoot, path, 'package.json'))).version !== info.version)
      throw Error('RELEASE_INSTALLED_VERSION');
    packages++;
  }
  for (const name of Object.keys({
    ...lock.packages[''].dependencies,
    ...lock.packages[''].devDependencies,
  }))
    if (!installed.packages[`node_modules/${name}`]) throw Error('RELEASE_DEPENDENCY_MISSING');
  if (!/^v24\./.test(process.version) || Number(process.versions.node.split('.')[1]) < 21)
    throw Error('RELEASE_NODE_VERSION');
  return {
    root: dependencyRoot,
    lockSha256: sha(lockBytes),
    installedInventorySha256: sha(installedBytes),
    packages,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    portable: false,
  };
}
async function samples(root) {
  const b = await exactFile(root, 'dist/api/samples/MANIFEST.json'),
    m = JSON.parse(b);
  if (b.length > 16384) throw Error('RELEASE_SAMPLE_BOUND');
  for (const name of ['daily', 'stakes', 'holders', 'maturities', 'markets']) {
    const value = await exactFile(root, `dist/api/samples/${name}.csv`);
    if (
      value.length > 16384 ||
      value.length !== m.files[name]?.bytes ||
      sha(value) !== m.files[name]?.sha256
    )
      throw Error('RELEASE_SAMPLE_IDENTITY');
  }
  return sha(b);
}
async function assets(root) {
  await exactFile(root, 'config/limits.json');
  await exactFile(root, 'dist/api/main.js');
  await exactFile(root, 'dist/api/entry.js');
  const html = (await exactFile(root, 'dist/web/index.html')).toString();
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((x) => x.includes('/assets/'));
  if (!refs.length) throw Error('RELEASE_WEB_ASSETS');
  for (const ref of refs) {
    if (!ref.startsWith('/assets/') || ref.includes('..') || ref.includes('?'))
      throw Error('RELEASE_WEB_ASSET_PATH');
    await exactFile(root, `dist/web/${ref.slice(1)}`);
  }
  return {
    refs,
    openapiSha256: sha(await exactFile(root, 'dist/web/openapi.json')),
  };
}

export async function buildRelease(planFile) {
  const p = await json(local(planFile));
  const sourceRoot = local(p.sourceRoot),
    outputRoot = local(p.outputRoot),
    dependencyRoot = local(p.dependencyRoot);
  if (
    outputRoot === sourceRoot ||
    sourceRoot.startsWith(outputRoot + sep) ||
    outputRoot.startsWith(sourceRoot + sep)
  )
    throw Error('RELEASE_OUTPUT_OWNERSHIP');
  const mapBytes = await readFile(local(p.sourceMapFile));
  if (sha(mapBytes) !== p.sourceMapSha256) throw Error('RELEASE_SOURCE_MAP');
  const map = JSON.parse(mapBytes),
    names = new Set();
  if (!Array.isArray(map) || map.length < 1 || map.length > 2000)
    throw Error('RELEASE_SOURCE_BOUND');
  for (const r of map) {
    member(r.path);
    if (names.has(r.path) || !hex.test(r.sha256)) throw Error('RELEASE_SOURCE_ENTRY');
    names.add(r.path);
    const b = await exactFile(sourceRoot, r.path);
    if (b.length !== r.bytes || sha(b) !== r.sha256)
      throw Error('RELEASE_SOURCE_IDENTITY:' + r.path);
  }
  const git = (...a) => execFileSync('git', ['-C', sourceRoot, ...a], { encoding: 'utf8' }).trim();
  if (
    git('rev-parse', 'HEAD') !== p.sourceCommit ||
    git('rev-parse', 'HEAD^{tree}') !== p.sourceTree ||
    git('diff', '--name-only') ||
    git('diff', '--cached', '--name-only')
  )
    throw Error('RELEASE_SOURCE_REVISION');
  const dependencies = await checkDependencies(sourceRoot, dependencyRoot);
  const profile = await readFile(local(p.profileFile));
  if (sha(profile) !== p.profileSha256 || profile.length > 16384)
    throw Error('RELEASE_PROFILE_IDENTITY');
  await mkdir(outputRoot); // Exclusivity: never reuse an old dist or erase a build.
  const stage = join(outputRoot, '_build/source');
  for (const r of map) await put(join(stage, r.path), await exactFile(sourceRoot, r.path));
  await symlink(join(dependencyRoot, 'node_modules'), join(stage, 'node_modules'), 'junction');
  await mkdir(join(outputRoot, '_build/tmp'));
  const guard = pathToFileURL(join(stage, 'tests/mainline/deny-network.mjs')).href;
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    TEMP: join(outputRoot, '_build/tmp'),
    TMP: join(outputRoot, '_build/tmp'),
    NODE_OPTIONS: `--import=${guard}`,
    NO_COLOR: '1',
  };
  const commands = [
    ['scripts/openapi.mjs'],
    ['scripts/openapi.mjs', '--check'],
    ['node_modules/typescript/bin/tsc', '--noEmit'],
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
    ['scripts/build-samples.mjs'],
    ['node_modules/vite/bin/vite.js', 'build'],
  ];
  const receipts = [];
  for (const args of commands) {
    const startedAt = new Date().toISOString();
    const r = spawnSync(process.execPath, args, {
      cwd: stage,
      env,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    receipts.push({
      args,
      startedAt,
      endedAt: new Date().toISOString(),
      status: r.status,
      signal: r.signal,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error?.message,
    });
    await writeFile(
      join(outputRoot, '_build/COMMANDS.json'),
      JSON.stringify(receipts, null, 2) + '\n',
    );
    if (r.status !== 0 || r.error) throw Error('RELEASE_BUILD_FAILED:' + args.join(' '));
  }
  if (
    !(await readFile(join(stage, 'docs/openapi.json'))).equals(
      await exactFile(sourceRoot, 'docs/openapi.json'),
    )
  )
    throw Error('RELEASE_GENERATED_CONTRACT_CHANGED');
  for (const n of await files(join(stage, 'dist')))
    await put(join(outputRoot, 'dist', n), await readFile(join(stage, 'dist', n)));
  for (const [from, to] of [
    ['package.json', 'package.json'],
    ['package-lock.json', 'package-lock.json'],
    ['config/limits.json', 'config/limits.json'],
    ['build/release-candidate.mjs', 'release-candidate.mjs'],
    ['tests/mainline/deny-network.mjs', 'network-deny.mjs'],
    ['scripts/participant-refresh-backup.mjs', 'scripts/participant-refresh-backup.mjs'],
  ])
    await put(join(outputRoot, to), await exactFile(sourceRoot, from));
  await put(join(outputRoot, 'SOURCE_MAP.json'), mapBytes);
  await symlink(join(dependencyRoot, 'node_modules'), join(outputRoot, 'node_modules'), 'junction');
  const payload = [...(await files(join(outputRoot, 'dist')))]
    .map((n) => `dist/${n}`)
    .concat([
      'package.json',
      'package-lock.json',
      'config/limits.json',
      'release-candidate.mjs',
      'network-deny.mjs',
      'scripts/participant-refresh-backup.mjs',
      'SOURCE_MAP.json',
    ])
    .sort();
  const entries = [];
  for (const path of payload) {
    const b = await exactFile(outputRoot, path);
    entries.push({ path, bytes: b.length, sha256: sha(b) });
  }
  const manifest = {
    format: 'hdd-host-serving-release-1',
    createdAtUtc: new Date().toISOString(),
    source: {
      commit: p.sourceCommit,
      tree: p.sourceTree,
      sourceMapSha256: p.sourceMapSha256,
      files: map.length,
    },
    dependencies,
    profile: {
      path: local(p.profileFile),
      sha256: p.profileSha256,
      dataIdentity: p.dataIdentity,
    },
    sampleManifestSha256: await samples(outputRoot),
    ...(await assets(outputRoot)),
    files: entries,
  };
  const b = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await put(join(outputRoot, 'RELEASE_MANIFEST.json'), b);
  return {
    status: 'BUILT',
    outputRoot,
    manifestSha256: sha(b),
    files: entries.length,
    sourceCommit: p.sourceCommit,
  };
}

export async function verifyRelease(root, expectedManifest, profileFile) {
  root = local(root);
  profileFile = local(profileFile);
  const b = await exactFile(root, 'RELEASE_MANIFEST.json');
  if (!hex.test(expectedManifest) || sha(b) !== expectedManifest)
    throw Error('RELEASE_MANIFEST_IDENTITY');
  const m = JSON.parse(b);
  if (
    m.format !== 'hdd-host-serving-release-1' ||
    m.dependencies.platform !== process.platform ||
    m.dependencies.arch !== process.arch ||
    m.dependencies.node !== process.version
  )
    throw Error('RELEASE_HOST_IDENTITY');
  const seen = new Set();
  for (const r of m.files) {
    if (seen.has(r.path)) throw Error('RELEASE_DUPLICATE_FILE');
    seen.add(r.path);
    const value = await exactFile(root, r.path);
    if (value.length !== r.bytes || sha(value) !== r.sha256)
      throw Error('RELEASE_ARTIFACT_IDENTITY:' + r.path);
  }
  const dist = (await files(join(root, 'dist'))).map((n) => `dist/${n}`);
  if (
    dist.some((n) => !seen.has(n)) ||
    m.files.filter((r) => r.path.startsWith('dist/')).length !== dist.length
  )
    throw Error('RELEASE_UNEXPECTED_ASSET');
  if (sha(await exactFile(root, 'SOURCE_MAP.json')) !== m.source.sourceMapSha256)
    throw Error('RELEASE_SOURCE_MAP');
  if (
    (await samples(root)) !== m.sampleManifestSha256 ||
    (await assets(root)).openapiSha256 !== m.openapiSha256
  )
    throw Error('RELEASE_ASSET_CONTRACT');
  const dependencies = await checkDependencies(root, m.dependencies.root);
  if (
    dependencies.installedInventorySha256 !== m.dependencies.installedInventorySha256 ||
    (await realpath(join(root, 'node_modules'))) !==
      (await realpath(join(m.dependencies.root, 'node_modules')))
  )
    throw Error('RELEASE_DEPENDENCY_LOCATION');
  if (profileFile !== m.profile.path || sha(await readFile(profileFile)) !== m.profile.sha256)
    throw Error('RELEASE_PROFILE_IDENTITY');
  const { readProductProfile } = await import(
    pathToFileURL(join(root, 'dist/services/product-daily/open.js'))
  );
  await readProductProfile(profileFile); // Schema/identity/path validation only. No base open.
  return {
    status: 'VERIFIED',
    source: m.source,
    files: m.files.length,
    profile: m.profile,
    dependencies,
    manifestSha256: expectedManifest,
  };
}

export async function verifyDataSelection(profileFile, expected) {
  const profile = await json(local(profileFile));
  async function small(root, name) {
    const s = await lstat(join(root, name));
    if (s.size > 65536) throw Error('RELEASE_DATA_HEADER_BOUND');
    return JSON.parse(await exactFile(root, name));
  }
  const state = await small(profile.productRoot, 'STORAGE.json');
  const current = await small(profile.productRoot, 'CURRENT.json');
  const pair = await small(profile.participantRoot, 'CURRENT.json');
  const same = (a, b) => a.version === b.version && a.manifestSha256 === b.manifestSha256;
  if (
    state.sequence !== expected.selectedSequence ||
    !same(state.current, expected.current) ||
    !same(state.rollback, expected.rollback) ||
    !same(current, expected.current) ||
    pair.generation !== expected.participant.generation ||
    pair.descriptorSha256 !== expected.participant.descriptorSha256 ||
    !same(pair.product, expected.current)
  )
    throw Error('RELEASE_DATA_SELECTION');
  return {
    status: 'SELECTION_HEADERS_MATCH',
    sequence: state.sequence,
    current,
    rollback: state.rollback,
    participant: pair,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === ownFile) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'build' && args.length === 1)
      console.log(JSON.stringify(await buildRelease(args[0])));
    else if (['verify', 'serve'].includes(command) && args.length === 3) {
      const result = await verifyRelease(...args);
      console.log(JSON.stringify(result));
      if (command === 'serve') {
        if (
          process.env.HDD_V2_API_MODE !== 'product' ||
          process.env.HDD_V2_PRODUCT_PROFILE !== local(args[2]) ||
          process.env.HDD_V2_HTTP_HOST !== '127.0.0.1' ||
          process.env.HDD_V2_DB_HOST ||
          process.env.HDD_V2_ALLOW_LIVE_RPC === 'true' ||
          process.env.HDD_V2_EXPORT_PATH
        )
          throw Error('RELEASE_SERVING_PROFILE');
        await import(pathToFileURL(join(local(args[0]), 'network-deny.mjs')));
        console.log(
          JSON.stringify(await verifyDataSelection(args[2], result.profile.dataIdentity)),
        );
        await import(pathToFileURL(join(local(args[0]), 'dist/api/main.js')));
      }
    } else
      throw Error(
        'Usage: release-candidate.mjs build PLAN | verify|serve ARTIFACT MANIFEST_SHA256 PROFILE',
      );
  } catch (e) {
    console.error(JSON.stringify({ status: 'REFUSED', message: e.message }));
    process.exitCode = 1;
  }
}
