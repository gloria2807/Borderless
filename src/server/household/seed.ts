/**
 * Demo household seed. ALL VALUES ARE ILLUSTRATIVE DEMO DATA — not a real household.
 *
 * Story: mid-month, the household has spent ₦7,000 of a ₦15,000 budget.
 * Electricity has ~1 day left and data a few hours — both running low.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import { PROVIDERS } from "../providers/registry";

export const DEMO_HOUSEHOLD_ID = "hh_demo";
export const DEMO_ACCOUNTS = {
  electricity: "acc_demo_meter",
  airtime: "acc_demo_airtime",
  data: "acc_demo_data",
} as const;

/** Fixed simulated start: 14 Nov 2026, 07:00 WAT (06:00Z). Deterministic across resets. */
export const DEMO_SIM_START = Date.UTC(2026, 10, 14, 6, 0, 0);
const HOUR = 3_600_000;

export async function seedDemoHousehold(db: Database): Promise<void> {
  const now = new Date(DEMO_SIM_START);

  await db.insert(s.utilityProviders).values(
    Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      countryCode: p.countryCode,
      networks: p.networks,
      minAmountNgn: p.minAmountNgn,
      maxAmountNgn: p.maxAmountNgn,
      available: true,
    })),
  );

  await db.insert(s.households).values({ id: DEMO_HOUSEHOLD_ID, name: "Adeyemi Household", simulatedNow: now });
  await db.insert(s.householdMembers).values({ id: "mem_demo_owner", householdId: DEMO_HOUSEHOLD_ID, name: "Household owner", role: "owner" });

  await db.insert(s.householdBudgets).values({
    id: "bud_demo_nov",
    householdId: DEMO_HOUSEHOLD_ID,
    period: "monthly",
    amountNgn: 15_000,
    priorSpendNgn: 7_000,
    periodStart: new Date(Date.UTC(2026, 10, 1)),
    periodEnd: new Date(Date.UTC(2026, 11, 1)),
    active: true,
  });

  await db.insert(s.agentPolicies).values({
    householdId: DEMO_HOUSEHOLD_ID,
    autoPurchaseEnabled: true,
    perPurchaseLimitNgn: 5_000,
    overallAgentLimitNgn: 8_000,
    manualApprovalThresholdNgn: 4_000,
    priorities: ["electricity", "data", "airtime"],
    approvedServices: ["electricity", "airtime", "data"],
    approvedNetworks: ["mtn"],
    approvedProviderIds: Object.values(PROVIDERS).map((p) => p.id),
  });

  await db.insert(s.utilityAccounts).values([
    { id: DEMO_ACCOUNTS.electricity, householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: PROVIDERS.electricity.id, label: "Home meter", identifier: "45012345678" },
    { id: DEMO_ACCOUNTS.airtime, householdId: DEMO_HOUSEHOLD_ID, kind: "airtime", providerId: PROVIDERS.airtime.id, label: "Owner's line", identifier: "+2348030000417", network: "mtn" },
    { id: DEMO_ACCOUNTS.data, householdId: DEMO_HOUSEHOLD_ID, kind: "data", providerId: PROVIDERS.data.id, label: "Owner's line", identifier: "+2348030000417", network: "mtn" },
  ]);

  await db.insert(s.utilityBalances).values([
    { accountId: DEMO_ACCOUNTS.electricity, balance: 8, unit: "kWh", baselineUsagePerHour: 0.32 },
    { accountId: DEMO_ACCOUNTS.airtime, balance: 200, unit: "NGN", baselineUsagePerHour: 3 },
    { accountId: DEMO_ACCOUNTS.data, balance: 150, unit: "MB", baselineUsagePerHour: 22, activeBundle: "1.5 GB · 30 days", expiresAt: new Date(DEMO_SIM_START + 9 * 24 * HOUR) },
  ]);

  // A short, plausible usage history (simulated) so forecasts have something to work with.
  const history: (typeof s.usageRecords.$inferInsert)[] = [];
  const series: [string, number, number][] = [
    [DEMO_ACCOUNTS.electricity, 8, 0.32],
    [DEMO_ACCOUNTS.airtime, 200, 3],
    [DEMO_ACCOUNTS.data, 150, 22],
  ];
  for (const [accountId, finalBalance, perHour] of series) {
    for (let h = 24; h >= 1; h -= 1) {
      const wobble = 1 + 0.25 * Math.sin(h * 1.7);
      history.push({
        id: `use_seed_${accountId}_${h}`,
        accountId,
        simTime: new Date(DEMO_SIM_START - h * HOUR),
        delta: Number((perHour * wobble).toFixed(3)),
        balanceAfter: Number((finalBalance + perHour * (h - 1)).toFixed(3)),
        source: "seed",
      });
    }
  }
  await db.insert(s.usageRecords).values(history);
}

/** Delete every row (children first). Schema is left intact. */
export async function wipeAll(db: Database): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  for (const table of [
    s.activityEvents, s.receipts, s.fulfilments, s.providerSettlements, s.payments, s.purchases,
    s.agentDecisions, s.usageRecords, s.utilityBalances, s.utilityAccounts, s.agentPolicies,
    s.householdBudgets, s.householdMembers, s.households, s.utilityProviders, s.demoScenarios, s.demoFaults,
  ]) {
    await db.delete(table);
  }
  await db.run(sql`PRAGMA foreign_keys = ON`);
}
