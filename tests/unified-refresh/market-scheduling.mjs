// Denied-network synthetic entry only.
import { runFixture } from './operating-fixture.mjs';
import { runOperating } from '../../scripts/refresh-data.mjs';
await runFixture(process.argv[2], process.argv[3] ?? 'scheduling-mixed', runOperating);
