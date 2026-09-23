import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { coordinate } from '../../scripts/operator/reconstruction-job.mjs';
import { jobFixture } from './job-fixture.mjs';
const root = resolve(process.argv[2]);
if (!root.includes('clock-and-runner')) throw Error('Explicit disposable fixture root required');
globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const fixture = jobFixture(root, process.argv[3] ?? 'complete');
const result = await coordinate(fixture.options, fixture.adapter);
writeFileSync(
  join(root, 'process-proof.json'),
  JSON.stringify(
    {
      result,
      events: fixture.events,
      children: fixture.children,
      pid: process.pid,
      platform: process.platform,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
process.exitCode =
  result.outcome === 'SCOPED_INTERVAL_COMPLETE' ? 0 : result.outcome.startsWith('PAUSED_') ? 3 : 2;
