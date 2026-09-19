import { readFile, stat } from 'node:fs/promises';

export async function processStart(path = '/proc/self/stat') {
  const raw = await readFile(path, 'utf8');
  return raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19];
}
export async function workerHealthy() {
  const path = (process.env.HDD_V2_STORAGE_PATH ?? '/state') + '/worker.json';
  if ((await stat(path)).size > 2048) return false;
  const state = JSON.parse(await readFile(path, 'utf8'));
  const age = Date.now() - state.checkedAt;
  return state.processStart === (await processStart('/proc/1/stat')) && age >= 0 && age < 90000;
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/worker-health.js')) {
  try {
    if (!(await workerHealthy())) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
