import https from 'node:https';
import { createHash } from 'node:crypto';
import { open, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInput } from '../src/worker/history/input.ts';

const sourceUrl = 'https://hexdailystats.com/fulldatapulsechain';
const limit = 16 * 1024 * 1024;
function allowed(url) {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    ['hexdailystats.com', 'hexstats.today'].includes(url.hostname) &&
    url.pathname === '/fulldatapulsechain' &&
    !url.search &&
    !url.hash
  );
}

// One operator-invoked file download. Never called by import, API or a scheduled job.
// The injected request/limits exist solely for local transport fixtures.
export async function download(
  path,
  { request = https.get, maxBytes = limit, timeoutMs = 60000 } = {},
) {
  const receipt = {
    source: 'hexdailystats',
    sourceKind: 'bounded-public-download',
    chainId: 369,
    requestedUrl: sourceUrl,
    finalUrl: sourceUrl,
    acquiredAt: new Date().toISOString(),
    requests: [],
    observedWireBodyBytes: 0,
    savedBytes: 0,
    sha256: null,
    outcome: 'failed',
    encoding: 'identity',
    note: 'Application-observed body bytes; TLS/kernel read-ahead is not measured.',
  };
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('60-second acquisition deadline exceeded.')),
    timeoutMs,
  );
  const hash = createHash('sha256');
  let file;
  try {
    file = await open(path, 'wx');
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = { url: receipt.finalUrl, status: null, observedBytes: 0 };
      receipt.requests.push(entry);
      const response = await new Promise((accept, reject) => {
        const req = request(
          receipt.finalUrl,
          {
            signal: controller.signal,
            headers: { 'Accept-Encoding': 'identity', Accept: 'application/json' },
          },
          accept,
        );
        req.once('error', reject);
      });
      entry.status = response.statusCode;
      let location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        location = new URL(response.headers.location ?? '', receipt.finalUrl);
        if (attempt !== 0 || !response.headers.location || !allowed(location)) {
          response.destroy();
          throw new Error('Unexpected redirect; no further request permitted.');
        }
      }
      if (!location && response.statusCode !== 200) {
        response.destroy();
        throw new Error(`HTTP ${response.statusCode}; no retry permitted.`);
      }
      if (
        response.headers['content-encoding'] &&
        response.headers['content-encoding'] !== 'identity'
      ) {
        response.destroy();
        throw new Error('Compressed response refused; decompression is unsupported.');
      }
      for await (const chunk of response) {
        entry.observedBytes += chunk.length;
        receipt.observedWireBodyBytes += chunk.length;
        if (receipt.observedWireBodyBytes > maxBytes) {
          response.destroy();
          throw new Error('Body byte admission limit exceeded (crossing chunk counted).');
        }
        if (!location) {
          await file.write(chunk);
          hash.update(chunk);
          receipt.savedBytes += chunk.length;
        }
      }
      if (location) {
        receipt.finalUrl = location.href;
        continue;
      }
      if (!response.complete) throw new Error('Truncated response.');
      await file.sync();
      parseInput(await readFile(path));
      receipt.outcome = 'downloaded-not-yet-validated';
      break;
    }
  } catch (error) {
    receipt.diagnostic = String(error.message).slice(0, 512);
  } finally {
    controller.abort();
    clearTimeout(timer);
    receipt.sha256 = hash.digest('hex');
    await file?.close();
    await writeFile(path + '.receipt.json', JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
    });
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node scripts/history-download.mjs <new-output.json>');
  const receipt = await download(resolve(process.argv[2]));
  console.log(JSON.stringify(receipt));
  if (receipt.outcome !== 'downloaded-not-yet-validated') process.exitCode = 1;
}
