import fs from "node:fs";
import path from "node:path";
import {
  s,
  c,
  dir,
  docker,
  owned,
  runner,
  healthy,
} from "./followthrough-lib.mjs";
const suite = process.argv[2],
  offline = process.argv.includes("--worker-only");
const outage = process.argv.includes("--smtp-outage");
if (outage && !offline) throw Error("OUTAGE_REQUIRES_STOPPED_APP");
if (
  ![
    "payment",
    "starvation",
    "auth",
    "reminders",
    "time",
    "integration",
    "controls",
  ].includes(suite)
)
  throw Error("UNKNOWN_SUITE");
const output = fs.mkdtempSync(path.join(dir, suite + "-"));
console.log("EVIDENCE " + output);
let error;
try {
  if (process.argv.includes("--restart-first")) {
    owned(s.containers.app);
    docker(["stop", "--time", "15", s.containers.app]);
    docker(["start", s.containers.app]);
    await healthy(c.origin);
  }
  if (offline) {
    owned(s.containers.app);
    docker(["stop", "--time", "15", s.containers.app]);
  }
  if (outage) {
    owned(s.containers.inbox);
    docker(["stop", "--time", "10", s.containers.inbox]);
  }
  runner(
    "tests/" + suite + ".mjs",
    process.argv.slice(3).filter((x) => !x.startsWith("--")),
    undefined,
    [],
    output,
  );
} catch (e) {
  error = e;
} finally {
  if (outage)
    try {
      owned(s.containers.inbox);
      docker(["start", s.containers.inbox]);
    } catch (e) {
      error = error
        ? new AggregateError([error, e], "TEST_AND_INBOX_RESTART_FAILED")
        : e;
    }
  if (offline)
    try {
      owned(s.containers.app);
      docker(["start", s.containers.app]);
      await healthy(c.origin);
    } catch (e) {
      error = error
        ? new AggregateError([error, e], "TEST_AND_RESTART_FAILED")
        : e;
    }
}
if (error) throw error;
