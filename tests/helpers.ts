import { Keypair } from "@stellar/stellar-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetEnvCache } from "@/server/config/env";
import { createDatabase, setDatabaseForTesting, type Database } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { DEMO_HOUSEHOLD_ID, resetDemo, seedDemoHousehold } from "@/server/household/seed";
import { scenarioById } from "@/server/demo/scenarios";

export const TEST_KEYS = {
  agent: Keypair.random(),
  electricity: Keypair.random().publicKey(),
  airtime: Keypair.random().publicKey(),
  data: Keypair.random().publicKey(),
  powergrid: Keypair.random().publicKey(),
  topuphub: Keypair.random().publicKey(),
  datalink: Keypair.random().publicKey(),
  gridsense: Keypair.random().publicKey(),
  meterlab: Keypair.random().publicKey(),
};

export function configureTestEnv(overrides: Record<string, string> = {}) {
  Object.assign(process.env, {
    APP_BASE_URL: "http://provider.test",
    AGENT_STELLAR_SECRET: TEST_KEYS.agent.secret(),
    AGENT_STELLAR_PUBLIC: TEST_KEYS.agent.publicKey(),
    PROVIDER_ELECTRICITY_PAYTO: TEST_KEYS.electricity,
    PROVIDER_POWERGRID_PAYTO: TEST_KEYS.powergrid,
    PROVIDER_TOPUPHUB_PAYTO: TEST_KEYS.topuphub,
    PROVIDER_DATALINK_PAYTO: TEST_KEYS.datalink,
    PROVIDER_GRIDSENSE_PAYTO: TEST_KEYS.gridsense,
    PROVIDER_METERLAB_PAYTO: TEST_KEYS.meterlab,
    PROVIDER_AIRTIME_PAYTO: TEST_KEYS.airtime,
    PROVIDER_DATA_PAYTO: TEST_KEYS.data,
    DEMO_NGN_PER_TESTNET_USDC: "100000",
    ...overrides,
  });
  resetEnvCache();
}

/**
 * The limits most payment-mechanics tests were written against (₦5,000 per request, approval
 * above ₦4,000, ₦15,000 budget). They keep those tests focused on what they test (x402, quotes,
 * approvals, recovery). The shipped demo persona (2 / 4 / 10 USDC) is covered by
 * tests/persona-policy.test.ts and the scenario tests, which seed it unchanged.
 */
export const MECHANICS_TEST_LIMITS = { perPurchaseLimitNgn: 5_000, manualApprovalThresholdNgn: 4_000, overallAgentLimitNgn: 8_000, taskBudgetNgn: 6_000, dailyAgentBudgetNgn: 8_000 } as const;

export async function applyMechanicsTestLimits(db: Database): Promise<void> {
  await db.update(schema.agentPolicies).set(MECHANICS_TEST_LIMITS).where(eq(schema.agentPolicies.householdId, DEMO_HOUSEHOLD_ID));
  await db.update(schema.householdBudgets).set({ amountNgn: 15_000, priorSpendNgn: 7_000 }).where(eq(schema.householdBudgets.householdId, DEMO_HOUSEHOLD_ID));
}

/** Fresh, migrated, seeded database in a temp file (persona: false applies MECHANICS_TEST_LIMITS). */
export async function freshDatabase(opts: { persona?: boolean } = {}): Promise<Database> {
  const dir = mkdtempSync(path.join(tmpdir(), "borderless-test-"));
  const holder = createDatabase(`file:${path.join(dir, "test.db")}`);
  setDatabaseForTesting(holder);
  await runMigrations(holder.db);
  await seedDemoHousehold(holder.db, "both-low");
  if (!opts.persona) await applyMechanicsTestLimits(holder.db);
  return holder.db;
}

/** Load a scenario (its budget, balances and faults) under MECHANICS_TEST_LIMITS plus the scenario's own policy. */
export async function resetScenario(db: Database, scenarioId: string) {
  const scenario = await resetDemo(db, scenarioId);
  await db.update(schema.agentPolicies).set({ ...MECHANICS_TEST_LIMITS, ...scenarioById(scenarioId).policy }).where(eq(schema.agentPolicies.householdId, DEMO_HOUSEHOLD_ID));
  return scenario;
}
