import { readFileSync, statSync } from 'node:fs';

/** Explicit files only; never search dotenv files or inherited credential locations. */
export function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const path = env[name + '_FILE'];
  if (path && env[name]) throw new Error('Specify a secret value OR its file.');
  if (!path) return env[name];
  if (statSync(path).size > 4096) throw new Error('Secret file exceeds bound.');
  return readFileSync(path, 'utf8').trim();
}
