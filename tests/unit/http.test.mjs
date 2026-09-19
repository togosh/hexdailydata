import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('actual loopback scaffold is live but not ready or synced', async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/api/main.ts'], {
    env: {
      ...process.env,
      HDD_V2_MODE: 'scaffold',
      HDD_V2_HTTP_HOST: '127.0.0.1',
      HDD_V2_HTTP_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  try {
    const endpoint = await new Promise((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`Startup timeout: ${stderr}`)), 5_000);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        if (!stdout.includes('\n')) return;
        clearTimeout(timeout);
        try {
          resolve(`http://127.0.0.1:${JSON.parse(stdout.split('\n')[0]).port}`);
        } catch (error) {
          reject(error);
        }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => {
        clearTimeout(timeout);
        reject(new Error(`Premature exit ${code}: ${stderr}`));
      });
    });

    const live = await fetch(endpoint + '/health/live');
    assert.equal(live.status, 200);
    assert.equal((await live.json()).mode, 'scaffold');
    assert.equal((await fetch(endpoint + '/health/ready')).status, 503);
    const status = await (await fetch(endpoint + '/api/v2/status')).json();
    assert.equal(status.productionReady, false);
    assert.equal((await fetch(endpoint + '/api/v2/home')).status, 404);
    assert.equal((await fetch(endpoint + '/api/v2/status', { method: 'POST' })).status, 405);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  }
});
