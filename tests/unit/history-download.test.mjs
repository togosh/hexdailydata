import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { download } from '../../scripts/history-download.mjs';
import { parseInput } from '../../src/worker/history/input.ts';
import { rawRow } from '../history/fixture.mjs';

test('one bounded downloader: raw local HTTP redirect, overflow, truncation, timeout and rejected data witnesses', async () => {
  const root = await mkdtemp(resolve('artifacts/history-download-'));
  try {
    for (const mode of [
      'ok',
      'redirect',
      'wrong-redirect',
      'error',
      'html',
      'truncated',
      'overflow',
      'compressed',
      'timeout',
    ]) {
      let requests = 0;
      const server = http.createServer((req, res) => {
        requests++;
        if (mode === 'timeout') return;
        if (mode === 'wrong-redirect') {
          res.writeHead(302, { Location: 'https://example.com/fulldatapulsechain' });
          return res.end();
        }
        if (mode === 'redirect' && requests === 1) {
          res.writeHead(302, { Location: 'https://hexstats.today/fulldatapulsechain' });
          return res.end('redirect');
        }
        if (mode === 'error') {
          res.writeHead(503);
          return res.end('no');
        }
        if (mode === 'html') return res.end('<html>refused</html>');
        if (mode === 'compressed') {
          res.writeHead(200, { 'content-encoding': 'gzip' });
          return res.end('compressed');
        }
        if (mode === 'overflow') return res.end('x'.repeat(2048));
        if (mode === 'truncated') {
          res.writeHead(200, { 'Content-Length': 10000 });
          res.write('[{');
          return setTimeout(() => res.destroy(), 10);
        }
        res.end(JSON.stringify([rawRow(1261)]));
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        const file = join(root, mode + '.json');
        const result = await download(file, {
          maxBytes: mode === 'overflow' ? 1024 : 16777216,
          timeoutMs: mode === 'timeout' ? 30 : 3000,
          request: (_url, options, cb) =>
            http.get(`http://127.0.0.1:${server.address().port}`, options, cb),
        });
        assert.equal(requests, mode === 'redirect' ? 2 : 1);
        const saved = await readFile(file);
        assert.equal(result.savedBytes, saved.length);
        assert.equal(result.sha256, createHash('sha256').update(saved).digest('hex'));
        if (mode === 'ok' || mode === 'redirect') assert.equal(parseInput(saved).length, 1);
        else if (mode === 'html') {
          assert.throws(() => parseInput(saved));
          assert.equal(result.outcome, 'failed');
        } else assert.equal(result.outcome, 'failed');
        if (mode === 'overflow') assert.equal(result.observedWireBodyBytes, 2048);
      } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    }
  } finally {
    await rm(root, { recursive: true });
  }
});
