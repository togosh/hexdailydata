// The original smoke command now tests the supported compiled Compose path.
process.argv.push('--smoke');
await import('./test-ops.mjs');
