import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { dirname } from 'node:path';
import { maxBackupBytes, reserve } from './files.ts';

/** Subprocess stderr can contain connection details; report tool/exit, never payloads. */
export function startTool(name: string, args: string[], signal: AbortSignal, env = process.env) {
  signal.throwIfAborted();
  const child = spawn(name, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal,
    killSignal: 'SIGKILL',
  });
  child.stderr.resume();
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error(`${name} could not run or was cancelled.`)));
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} failed (exit ${code}).`)),
    );
  });
  void done.catch(() => {});
  return { child, output: child.stdout, done };
}
export async function boundedFile(stream: Readable, path: string, signal: AbortSignal) {
  let bytes = 0,
    checked = 0;
  const bound = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBackupBytes) return callback(new Error('Backup byte limit exceeded.'));
      if (bytes - checked >= 16 * 1024 * 1024) {
        checked = bytes;
        void reserve(dirname(path)).then(
          () => callback(null, chunk),
          (error) => callback(error),
        );
      } else callback(null, chunk);
    },
  });
  await pipeline(stream, bound, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
  return bytes;
}
export async function toolFile(
  name: string,
  args: string[],
  path: string,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
) {
  const tool = startTool(name, args, signal, env);
  try {
    const bytes = await boundedFile(tool.output, path, signal);
    await tool.done;
    return bytes;
  } catch (e) {
    tool.child.kill('SIGKILL');
    await tool.done.catch(() => {});
    throw e;
  }
}
