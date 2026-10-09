// Explicit finite gas entry point. No default requests, service or scheduler.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRefresh } from './market-refresh.mjs';
export const runProtocol = (config, options) =>
  runRefresh({ ...config, feed: 'protocol' }, options);
export async function main(args = process.argv.slice(2)) {
  const [mode, ...rest] = args;
  if (!['once', 'trial'].includes(mode) || rest.length !== 6) {
    console.log(
      'Explicit once|trial --profile FILE --output NEW_DIRECTORY --preflight FILE. No default gas requests.',
    );
    return 2;
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--profile', '--output', '--preflight'].includes(rest[i]) || options[rest[i]])
      throw Error('ARGUMENTS');
    options[rest[i]] = rest[i + 1];
  }
  const result = await runProtocol({
    mode,
    profilePath: options['--profile'],
    output: options['--output'],
    preflightPath: options['--preflight'],
  });
  console.log(JSON.stringify(result));
  return result.status === 'COMPLETE_FINITE_TRIAL' ? 0 : 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
