import { writeFile, readFile } from 'node:fs/promises';
import pg from 'pg';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { scale } from '../daily/scale.mjs';
const admin = new pg.Client({
  host: 'db',
  database: 'hexdailydata_v2',
  user: 'hdd_v2_admin',
  password: (await readFile(process.env.HDD_V2_ADMIN_PASSWORD_FILE, 'utf8')).trim(),
});
await admin.connect();
const worker = await connect(databaseConfig('worker')),
  api = await connect(databaseConfig('api'));
const measurements = {
  shape:
    'Existing Task05 million-stake/500k-account shape; deliberately not a raw replay-valid fixture or full seed audit.',
};
try {
  await scale({
    admin,
    worker,
    api,
    fresh: () => connect(databaseConfig('worker')),
    measurements,
    test: async (name, fn) => {
      if (name.startsWith('full-size fixture:')) {
        await fn();
        console.log('PASS', name);
      } else console.log('SKIP unrelated prior benchmark', name);
    },
  });
  await writeFile('/evidence/scale-input.json', JSON.stringify(measurements, null, 2));
} finally {
  await Promise.allSettled([admin.end(), worker.end(), api.end()]);
}
