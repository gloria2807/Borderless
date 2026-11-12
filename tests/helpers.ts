import { Keypair } from "@stellar/stellar-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetEnvCache } from "@/server/config/env";
import { createDatabase, setDatabaseForTesting, type Database } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { seedDemoHousehold } from "@/server/household/seed";

export const TEST_KEYS = {
  agent: Keypair.random(),
  electricity: Keypair.random().publicKey(),
  airtime: Keypair.random().publicKey(),
  data: Keypair.random().publicKey(),
};

export function configureTestEnv(overrides: Record<string, string> = {}) {
  Object.assign(process.env, {
    APP_BASE_URL: "http://provider.test",
    AGENT_STELLAR_SECRET: TEST_KEYS.agent.secret(),
    AGENT_STELLAR_PUBLIC: TEST_KEYS.agent.publicKey(),
    PROVIDER_ELECTRICITY_PAYTO: TEST_KEYS.electricity,
    PROVIDER_AIRTIME_PAYTO: TEST_KEYS.airtime,
    PROVIDER_DATA_PAYTO: TEST_KEYS.data,
    DEMO_NGN_PER_TESTNET_USDC: "100000",
    ...overrides,
  });
  resetEnvCache();
}

/** Fresh, migrated, seeded database in a temp file. */
export async function freshDatabase(): Promise<Database> {
  const dir = mkdtempSync(path.join(tmpdir(), "borderless-test-"));
  const holder = createDatabase(`file:${path.join(dir, "test.db")}`);
  setDatabaseForTesting(holder);
  await runMigrations(holder.db);
  await seedDemoHousehold(holder.db);
  return holder.db;
}
