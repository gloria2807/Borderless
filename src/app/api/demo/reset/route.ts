import { action, ok } from "@/server/api";
import { db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { seedDemoHousehold, wipeAll } from "@/server/household/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resets the SIMULATED household. On-chain testnet transactions are permanent and unaffected. */
export const POST = action(async () => {
  const database = db();
  await runMigrations(database);
  await wipeAll(database);
  await seedDemoHousehold(database);
  return ok({ reset: true });
});
