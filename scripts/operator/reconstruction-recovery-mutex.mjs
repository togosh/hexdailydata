import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Kernel ownership is released on process/host death. The persistent inode is
// never deleted, so retries cannot race by replacing a held lock file.
export async function recoveryMutex(environment) {
  const path = join(environment, '.reconstruction-recovery.lock');
  const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
  const child =
    process.platform === 'win32'
      ? spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference='Stop'; $taskLock=[System.IO.File]::Open(${quote(path)},[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $taskLock.Dispose() }`,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        )
      : spawn(
          'flock',
          ['--exclusive', '--nonblock', path, 'sh', '-c', 'echo LOCKED; read answer'],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
  let alive = true;
  const completed = new Promise((resolve) =>
    child.once('close', (code) => {
      alive = false;
      resolve(code);
    }),
  );
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Recovery exclusion timed out')), 10000);
      child.stdout.on('data', (bytes) => {
        output += bytes;
        if (/LOCKED\r?\n/.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(Error('Recovery/coordinator already owned'));
      });
    });
  } catch (error) {
    child.stdin.end();
    await completed;
    throw error;
  }
  return Object.assign(
    async () => {
      child.stdin.end('release\n');
      await completed;
    },
    {
      check() {
        if (!alive) throw Error('Recovery kernel exclusion lost');
      },
    },
  );
}
