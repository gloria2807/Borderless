import "./_env";
import { db } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import { seedDemoHousehold, wipeAll } from "../src/server/household/seed";

const database = db();
await runMigrations(database);
await wipeAll(database);
await seedDemoHousehold(database);
console.log("Demo household reset: budget ₦15,000 (₦8,000 remaining), electricity 8 kWh, airtime ₦200, data 150 MB.");
