import "./_env";
import { db } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";

await runMigrations(db());
console.log("Database migrated.");
