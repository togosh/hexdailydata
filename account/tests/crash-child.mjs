import { config } from "../dist/server/config.js";
import { poolFor, guard } from "../dist/server/db.js";
import { processEvent } from "../dist/server/billing.js";
let input = "";
for await (const b of process.stdin) input += b;
const c = config(),
  p = poolFor(c);
await guard(p, c);
await processEvent(p, JSON.parse(input), new Date(), {
  [process.argv[2]]: () => process.exit(73),
});
process.exit(74);
