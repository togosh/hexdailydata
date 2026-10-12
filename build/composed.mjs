// Explicit host build only. Does not install dependencies or start a service.
import { readFileSync, statSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifest = JSON.parse(readFileSync(new URL('./inputs.json', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Serving now lives at the repository root; account remains a separate package.
export const physical = path => path === 'serving' ? '.' : path.replace(/^serving\//, '');
const read = (base, path) => readFileSync(resolve(base, physical(path)));
function requireFile(base, path) {
  if (!statSync(resolve(base, physical(path)), { throwIfNoEntry: false })?.isFile())
    throw Error(`Missing build input/asset: ${path}`);
}

export function checkInputs(base = root) {
  for (const name of manifest.roots)
    if (!statSync(resolve(base, name), { throwIfNoEntry: false })?.isDirectory())
      throw Error(`Missing composed root: ${name}`);
  for (const path of manifest.requiredInputs) requireFile(base, path);
  for (const name of [...Object.keys(manifest.sqlAssets), ...manifest.additionalSqlCopies])
    requireFile(base, `account/src/${name}`);
  for (const [name, installer] of Object.entries(manifest.sqlAssets)) {
    const source = read(base, `account/src/${installer}.ts`).toString();
    if (!source.includes(`./${name}`)) throw Error(`SQL installer mapping changed: ${name}`);
  }
  for (const [name, expected] of Object.entries(manifest.lockSha256))
    if (hash(read(base, `${name}/package-lock.json`)) !== expected)
      throw Error(`Locked dependencies changed: ${name}`);
}

export function checkDependencies(base = root) {
  for (const name of ['serving', 'account']) {
    const lock = JSON.parse(read(base, `${name}/package-lock.json`));
    const installed = JSON.parse(read(base, `${name}/node_modules/.package-lock.json`));
    for (const [path, info] of Object.entries(installed.packages)) {
      const expected = lock.packages[path];
      if (!expected || info.link || ['version', 'integrity', 'resolved'].some(k => info[k] !== expected[k]))
        throw Error(`Installed inventory differs from lock: ${name}/${path}`);
      const actual = JSON.parse(read(base, `${name}/${path}/package.json`));
      if (actual.version !== info.version) throw Error(`Installed version differs: ${name}/${path}`);
    }
    for (const dep of Object.keys({ ...lock.packages[''].dependencies, ...lock.packages[''].devDependencies }))
      if (!installed.packages[`node_modules/${dep}`]) throw Error(`Missing locked dependency: ${name}/${dep}`);
  }
}

function checkWeb(base, name, baseUrl) {
  const dir = `${name}/dist/${name === 'account' ? 'ui' : 'web'}`;
  const html = read(base, `${dir}/index.html`).toString();
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
    .filter(value => value.includes('/assets/'));
  if (!refs.length) throw Error(`Missing ${name} asset references`);
  for (const ref of refs) {
    if (!ref.startsWith(`${baseUrl}assets/`) || ref.includes('..'))
      throw Error(`Wrong ${name} asset base: ${ref}`);
    requireFile(base, `${dir}/${ref.slice(baseUrl.length)}`);
  }
  return refs;
}

export function checkSamples(base = root) {
  const names = ['daily', 'stakes', 'holders', 'maturities', 'markets'];
  const bounded = path => {
    requireFile(base, path);
    if (statSync(resolve(base, physical(path))).size > 16384) throw Error('Sample size bound');
    return read(base, path);
  };
  const source = bounded('delivery/samples/MANIFEST.json');
  const emitted = bounded('serving/dist/api/samples/MANIFEST.json');
  if (!source.equals(emitted)) throw Error('Sample manifest differs');
  const entries = JSON.parse(source).files;
  for (const name of names) {
    const original = bounded(`delivery/samples/${name}.csv`);
    const output = bounded(`serving/dist/api/samples/${name}.csv`);
    if (entries[name]?.bytes !== original.length || entries[name]?.sha256 !== hash(original) || !original.equals(output))
      throw Error(`Sample integrity differs: ${name}`);
  }
  return ['MANIFEST.json', ...names.map(name => `${name}.csv`)];
}

export function checkOutputs(base = root) {
  checkInputs(base);
  const samples = checkSamples(base);
  const assets = { serving: checkWeb(base, 'serving', '/'), account: checkWeb(base, 'account', '/account/') };
  if (!read(base, 'serving/docs/openapi.json').equals(read(base, 'serving/dist/web/openapi.json')))
    throw Error('Emitted OpenAPI differs from generated contract');
  for (const [name, installer] of Object.entries(manifest.sqlAssets)) {
    requireFile(base, `account/dist/server/${installer}.js`);
    if (!read(base, `account/dist/server/${installer}.js`).toString().includes(`./${name}`))
      throw Error(`Compiled SQL installer mapping changed: ${name}`);
  }
  for (const name of [...Object.keys(manifest.sqlAssets), ...manifest.additionalSqlCopies]) {
    requireFile(base, `account/dist/server/${name}`);
    if (!read(base, `account/src/${name}`).equals(read(base, `account/dist/server/${name}`)))
      throw Error(`SQL copy differs: ${name}`);
  }
  requireFile(base, 'serving/dist/api/main.js');
  requireFile(base, 'serving/dist/api/app.js');
  requireFile(base, 'account/dist/server/account-routes.js');
  return { roots: manifest.roots, assets, samples, sqlCopied: [...Object.keys(manifest.sqlAssets), ...manifest.additionalSqlCopies] };
}

export function build(base = root) {
  checkInputs(base);
  checkDependencies(base);
  const accepted = manifest.generatedContracts.map(path => [path, read(base, `serving/${path}`)]);
  function run(name, args) {
    const command = [process.execPath, ...args];
    console.log(JSON.stringify({ phase: 'start', cwd: name, command }));
    const result = spawnSync(process.execPath, args, { cwd: resolve(base, physical(name)), stdio: 'inherit' });
    console.log(JSON.stringify({ phase: 'exit', cwd: name, command, exit: result.status, signal: result.signal }));
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Build command failed: ${name}: ${args.join(' ')}`);
  }
  run('serving', ['scripts/openapi.mjs']);
  run('serving', ['scripts/openapi.mjs', '--check']);
  for (const [path, bytes] of accepted)
    if (!bytes.equals(read(base, `serving/${path}`))) throw Error(`Generated contract changed: ${path}`);
  run('serving', ['node_modules/typescript/bin/tsc', '--noEmit']);
  run('serving', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
  run('serving', ['scripts/build-samples.mjs']);
  run('serving', ['node_modules/vite/bin/vite.js', 'build']);
  run('account', ['node_modules/typescript/bin/tsc']);
  run('account', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.ui.json']);
  run('account', ['node_modules/vite/bin/vite.js', 'build', '--base', '/account/']);
  for (const name of [...Object.keys(manifest.sqlAssets), ...manifest.additionalSqlCopies])
    copyFileSync(resolve(base, `account/src/${name}`), resolve(base, `account/dist/server/${name}`));
  console.log(JSON.stringify({ composedBuild: 'PASS', ...checkOutputs(base) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check'))
    throw Error('Usage: node build/composed.mjs [--check]');
  if (process.argv[2] === '--check') console.log(JSON.stringify(checkOutputs()));
  else build();
}
