import { readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canaryPlanSchema, planDigest } from '../../dist/operator/canary-plan.js';
import { checkAuditBindings } from './audit-bindings.mjs';

// One short host supervisor, not a service. Its exclusive receipt spends the local
// invocation even if startup fails. The application inherits the earlier clock.
const [directory, override, planName = 'plan.json', approvalName = 'approval.json'] =
  process.argv.slice(2);
if (!directory || !override || ![planName, approvalName].every((s) => /^[a-z-]+\.json$/.test(s)))
  throw Error('canary-once <owned environment> <operator override> [plan.json] [approval.json]');
const root = resolve(directory),
  rel = relative(process.cwd(), root);
if (
  !rel ||
  rel.startsWith('..') ||
  isAbsolute(rel) ||
  !['.local', 'artifacts'].includes(rel.split(/[\\/]/)[0])
)
  throw Error('Owned environment required.');
const overridePath = resolve(override),
  overrideRel = relative(root, overridePath);
if (!overrideRel || overrideRel.startsWith('..') || isAbsolute(overrideRel))
  throw Error('Override must belong to this environment.');
for (let p = root; p !== dirname(p); p = dirname(p))
  if (lstatSync(p).isSymbolicLink()) throw Error('Indirect one-shot environment refused.');
if (realpathSync(root) !== root || lstatSync(overridePath).isSymbolicLink())
  throw Error('Indirect one-shot binding refused.');
if (existsSync(join(root, 'invocation.json'))) throw Error('One-shot invocation already spent.');
const config = JSON.parse(readFileSync(join(root, 'environment.json'), 'utf8'));
const plan = canaryPlanSchema.parse(
  JSON.parse(readFileSync(join(root, 'input', planName), 'utf8')),
);
if (
  plan.phases.length !== 1 ||
  !['common-prefix', 'pinned-audit', 'common-continue'].includes(plan.phases[0].kind) ||
  plan.project !== config.project ||
  plan.instance !== config.instance ||
  plan.release !== (config.current ?? config.built)
)
  throw Error('One-shot canary environment/image mismatch.');
const audit = ['pinned-audit', 'common-continue'].includes(plan.phases[0].kind);
const compose = [
  'compose',
  '--env-file',
  join(root, 'compose.env'),
  '-p',
  config.project,
  '-f',
  overridePath,
];
if (audit) {
  const inspect = (args) => {
    const result = spawnSync('docker', args, {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) throw Error('Pinned audit binding inspection failed.');
    return JSON.parse(result.stdout);
  };
  const graph = inspect([...compose, 'config', '--format', 'json']);
  const volume = inspect(['volume', 'inspect', plan.phases[0].admission.volume])[0];
  const names = graph.services.operator.volumes
    .filter((m) => m.type === 'volume')
    .map((m) => graph.volumes[m.source].name);
  const stateVolumes = inspect(['volume', 'inspect', ...names]);
  const running = spawnSync('docker', ['ps', '-q', '--filter', 'volume=' + volume.Name], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (running.status !== 0) throw Error('Cannot exclude competing retained database.');
  const ids = running.stdout.trim().split(/\s+/).filter(Boolean);
  const checked = checkAuditBindings(
    plan,
    graph,
    volume,
    stateVolumes,
    ids.length ? inspect(['inspect', ...ids]) : [],
  );
  writeFileSync(join(root, 'invocation-bindings.json'), JSON.stringify(checked, null, 2) + '\n', {
    flag: 'wx',
  });
}
const started = Date.now(),
  name =
    config.project +
    (plan.phases[0].kind === 'common-continue' ? '-continue' : audit ? '-audit' : '-prefix');
const argv = [
  ...(audit ? compose : ['scripts/operator/host.mjs', 'compose', directory, '-f', overridePath]),
  'run',
  '--name',
  name,
  '-T',
  '-e',
  'HDD_V2_ALLOW_LIVE_RPC=true',
  '-e',
  'HDD_V2_CANARY_OPT_IN=' + plan.session,
  '-e',
  'HDD_V2_CANARY_INVOKED_AT=' + started,
  'operator',
  'canary',
  'run',
  '/input/' + planName,
  '/input/' + approvalName,
];
const receipt = {
  started,
  deadline: started + plan.caps.milliseconds,
  session: plan.session,
  planDigest: planDigest(plan),
  name,
  image: plan.release,
  instance: plan.instance,
  argv,
};
writeFileSync(join(root, 'invocation.json'), JSON.stringify(receipt, null, 2) + '\n', {
  flag: 'wx',
});
const r = spawnSync(audit ? 'docker' : process.execPath, argv, {
  encoding: 'utf8',
  timeout: plan.caps.milliseconds,
  maxBuffer: 8 * 1024 * 1024,
});
const operatorEnded = Date.now();
writeFileSync(join(root, 'live-output.log'), (r.stdout ?? '') + (r.stderr ?? ''), { flag: 'wx' });
let shutdown = null;
if (r.error || operatorEnded - started >= plan.caps.milliseconds) {
  const stop = spawnSync('docker', ['stop', '--time', '5', name], {
    encoding: 'utf8',
    timeout: 15000,
  });
  shutdown = {
    status: stop.status,
    error: stop.error?.message,
    output: (stop.stdout ?? '') + (stop.stderr ?? ''),
  };
}
const ended = Date.now(),
  elapsedMs = ended - started;
const result = {
  ...receipt,
  ended,
  operatorEnded,
  elapsedMs,
  exit: r.status,
  error: r.error?.message,
  shutdown,
  withinDeadline: elapsedMs < plan.caps.milliseconds,
};
writeFileSync(join(root, 'invocation-result.json'), JSON.stringify(result, null, 2) + '\n', {
  flag: 'wx',
});
console.log(JSON.stringify(result));
process.exitCode = r.status === 0 && result.withinDeadline ? 0 : 2;
