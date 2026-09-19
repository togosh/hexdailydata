import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { developmentConfig } from '../src/api/config.ts';

let configuration = 'development; providers disabled';
try {
  developmentConfig(process.env);
} catch (error) {
  configuration = error.message;
  process.exitCode = 1;
}
const runtime = process.versions.node;
if (Number(runtime.split('.')[0]) !== 24 || Number(runtime.split('.')[1]) < 21)
  process.exitCode = 1;
const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8',
  timeout: 5_000,
});
console.log(
  JSON.stringify(
    {
      node: runtime,
      supportedNode: '24.21.0 or newer Node 24',
      configuration,
      lockfilePresent: fs.existsSync('package-lock.json'),
      builtWebPresent: fs.existsSync('dist/web/index.html'),
      docker: docker.status === 0 ? docker.stdout.trim() : 'unavailable (optional for local shell)',
      databaseSchema: 'not implemented; Task02',
      providerCapabilities: 'not checked; no network probes',
      ongoingCost: 'unmeasured; ceiling 60 USD/month',
      productionReady: false,
    },
    null,
    2,
  ),
);
