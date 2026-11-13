/**
 * Demo household seed. ALL VALUES ARE ILLUSTRATIVE DEMO DATA — not a real household.
 * The starting state comes from a demo scenario (see demo/scenarios.ts).
 */
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { DEFAULT_SCENARIO_ID, SCENARIOS, scenarioById, type ScenarioDefinition } from "../demo/scenarios";
import { ALL_PROVIDERS, PROVIDERS } from "../providers/registry";
import { recordEvent } from "../transactions/events";

export const DEMO_HOUSEHOLD_ID = "hh_demo";
export const DEMO_ACCOUNTS = {
  electricity: "acc_demo_meter",
  airtime: "acc_demo_airtime",
  data: "acc_demo_data",
} as const;

/** Fixed simulated start: 14 Nov 2026, 07:00 WAT (06:00Z). Deterministic across resets. */
export const DEMO_SIM_START = Date.UTC(2026, 10, 14, 6, 0, 0);
const HOUR = 3_600_000;
const UNITS: Record<UtilityKind, "kWh" | "NGN" | "MB"> = { electricity: "kWh", airtime: "NGN", data: "MB" };

export async function seedDemoHousehold(db: Database, scenarioId: string = DEFAULT_SCENARIO_ID): Promise<ScenarioDefinition> {
  const scenario = scenarioById(scenarioId);
  const now = new Date(DEMO_SIM_START);

  await db.insert(s.utilityProviders).values(
    ALL_PROVIDERS.map(({ definition: p }) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      countryCode: p.countryCode,
      networks: p.networks,
      minAmountNgn: p.minAmountNgn,
      maxAmountNgn: p.maxAmountNgn,
      available: !(scenario.providersDown ?? []).includes(p.id),
    })),
  );

  await db.insert(s.demoScenarios).values(SCENARIOS.map((x) => ({ id: x.id, name: x.name, description: x.summary, config: x })));

  await db.insert(s.households).values({ id: DEMO_HOUSEHOLD_ID, name: "Adeyemi Household", simulatedNow: now });
  await db.insert(s.householdMembers).values({ id: "mem_demo_owner", householdId: DEMO_HOUSEHOLD_ID, name: "Household owner", role: "owner" });

  await db.insert(s.householdBudgets).values({
    id: "bud_demo_nov",
    householdId: DEMO_HOUSEHOLD_ID,
    period: "monthly",
    amountNgn: scenario.budget.amountNgn,
    priorSpendNgn: scenario.budget.priorSpendNgn,
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
    ...scenario.policy,
    priorities: ["electricity", "data", "airtime"],
    approvedServices: ["electricity", "airtime", "data"],
    approvedNetworks: ["mtn"],
    approvedProviderIds: ALL_PROVIDERS.map((m) => m.definition.id),
  });

  if (scenario.faults?.length) await db.insert(s.demoFaults).values(scenario.faults.map((key) => ({ key, enabled: true })));

  await db.insert(s.utilityAccounts).values([
    { id: DEMO_ACCOUNTS.electricity, householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: PROVIDERS.electricity.id, label: "Home meter", identifier: "45012345678" },
    { id: DEMO_ACCOUNTS.airtime, householdId: DEMO_HOUSEHOLD_ID, kind: "airtime", providerId: PROVIDERS.airtime.id, label: "Owner's line", identifier: "+2348030000417", network: "mtn" },
    { id: DEMO_ACCOUNTS.data, householdId: DEMO_HOUSEHOLD_ID, kind: "data", providerId: PROVIDERS.data.id, label: "Owner's line", identifier: "+2348030000417", network: "mtn" },
  ]);

  const kinds: UtilityKind[] = ["electricity", "airtime", "data"];
  await db.insert(s.utilityBalances).values(
    kinds.map((kind) => {
      const u = scenario.utilities[kind];
      return {
        accountId: DEMO_ACCOUNTS[kind],
        balance: u.balance,
        unit: UNITS[kind],
        baselineUsagePerHour: u.perHour,
        usageMultiplier: u.multiplier ?? 1,
        ...(kind === "data" && u.expiresInHours
          ? { activeBundle: "1.5 GB · 30 days", expiresAt: new Date(DEMO_SIM_START + u.expiresInHours * HOUR) }
          : {}),
      };
    }),
  );

  // 24 hours of plausible usage history so forecasts have something to work with.
  const history: (typeof s.usageRecords.$inferInsert)[] = [];
  for (const kind of kinds) {
    const u = scenario.utilities[kind];
    let after = u.balance;
    for (let h = 1; h <= 24; h += 1) {
      const recent = h <= (u.recentHours ?? 0);
      const rate = recent && u.recentPerHour ? u.recentPerHour : u.perHour;
      const wobble = 1 + 0.25 * Math.sin(h * 1.7);
      const delta = Number((rate * wobble).toFixed(3));
      history.push({
        id: `use_seed_${kind}_${h}`,
        accountId: DEMO_ACCOUNTS[kind],
        simTime: new Date(DEMO_SIM_START - (h - 1) * HOUR),
        delta,
        balanceAfter: Number(after.toFixed(3)),
        source: "seed",
      });
      after += delta;
    }
  }
  await db.insert(s.usageRecords).values(history);

  await recordEvent(db, {
    householdId: DEMO_HOUSEHOLD_ID,
    category: "system",
    type: "demo.scenario_loaded",
    severity: "info",
    title: `Demo scenario: ${scenario.name}`,
    detail: scenario.summary,
    data: { scenarioId: scenario.id },
    simTime: now,
  });
  return scenario;
}

/** Delete every row (children first). Schema is left intact. */
export async function wipeAll(db: Database): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  for (const table of [
    s.activityEvents, s.receipts, s.fulfilments, s.providerQuotes, s.providerSettlements, s.payments, s.purchases,
    s.agentRunEvents, s.agentRuns, s.agentDecisions, s.usageRecords, s.utilityBalances, s.utilityAccounts, s.agentPolicies,
    s.householdBudgets, s.householdMembers, s.households, s.utilityProviders, s.demoScenarios, s.demoFaults,
  ]) {
    await db.delete(table);
  }
  await db.run(sql`PRAGMA foreign_keys = ON`);
}

/** Reset to a scenario: wipe, reseed. Returns the scenario loaded. */
export async function resetDemo(db: Database, scenarioId?: string): Promise<ScenarioDefinition> {
  await wipeAll(db);
  return seedDemoHousehold(db, scenarioId);
}
