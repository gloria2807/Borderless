/**
 * Reset the demo household.
 *   pnpm db:reset                       # default scenario
 *   pnpm db:reset budget-covers-one     # any scenario id (see src/server/demo/scenarios.ts)
 */
import "./_env";
import { db, rawClient } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import { SCENARIOS } from "../src/server/demo/scenarios";
import { resetDemo } from "../src/server/household/seed";

const requested = process.argv[2];
if (requested && !SCENARIOS.some((s) => s.id === requested)) {
  console.error(`Unknown scenario "${requested}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(1);
}
const database = db();
await runMigrations(database);
const scenario = await resetDemo(database, requested);
console.log(`Demo household reset to "${scenario.name}".\n  ${scenario.summary}\n  Expect: ${scenario.expect}`);
// Close explicitly: the native client can crash on Windows if the process exits with it open.
rawClient().close();
