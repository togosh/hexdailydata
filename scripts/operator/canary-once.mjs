import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canaryPlanSchema, planDigest } from '../../dist/operator/canary-plan.js';

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
const config = JSON.parse(readFileSync(join(root, 'environment.json'), 'utf8'));
const plan = canaryPlanSchema.parse(
  JSON.parse(readFileSync(join(root, 'input', planName), 'utf8')),
);
if (
  plan.phases.length !== 1 ||
  plan.phases[0].kind !== 'common-prefix' ||
  plan.project !== config.project ||
  plan.instance !== config.instance ||
  plan.release !== (config.current ?? config.built)
)
  throw Error('Common prefix environment/image mismatch.');
const started = Date.now(),
  name = config.project + '-prefix';
const argv = [
  'scripts/operator/host.mjs',
  'compose',
  directory,
  '-f',
  overridePath,
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
const r = spawnSync(process.execPath, argv, {
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
