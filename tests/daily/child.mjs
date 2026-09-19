import { connect, databaseConfig } from '../../src/db/connect.ts';
import { ExportService } from '../../src/worker/exports/service.ts';
const stage = process.argv[2];
const service = new ExportService(() => connect(databaseConfig('worker')), '/exports');
await service.build(369, new AbortController().signal, async (s, id) => {
  if (s === stage) {
    process.send({ stage: s, id });
    await new Promise(() => {});
  }
});
