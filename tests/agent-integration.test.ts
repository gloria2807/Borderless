/**
 * Agent orchestration against a real (temporary) database: simulator → decision →
 * persisted audit record → purchase through the authority gate. Payment execution is
 * either disabled or routed to mocks; live payments are covered by scripts.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "@/server/agent/run";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID } from "@/server/household/seed";
import { approvePurchase, declinePurchase } from "@/server/transactions/approvals";
import { advanceTime, setUsageMultiplier } from "@/server/usage/simulator";
import { configureTestEnv, freshDatabase } from "./helpers";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const balance = async (id: string) => (await database.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, id)))[0]!;
const purchases = () => database.select().from(s.purchases);

describe("simulator", () => {
  it("is deterministic across identical households", async () => {
    await advanceTime(database, DEMO_HOUSEHOLD_ID, 10);
    const a = (await database.select().from(s.utilityBalances)).map((b) => [b.accountId, b.balance]).sort();
    const other = await freshDatabase();
    await advanceTime(other, DEMO_HOUSEHOLD_ID, 10);
    const b = (await other.select().from(s.utilityBalances)).map((x) => [x.accountId, x.balance]).sort();
    expect(a).toEqual(b);
  });

  it("drains balances, advances the clock and never goes negative", async () => {
    await advanceTime(database, DEMO_HOUSEHOLD_ID, 48);
    const [hh] = await database.select().from(s.households);
    expect(hh!.simulatedNow.toISOString()).toBe("2026-11-16T06:00:00.000Z");
    for (const b of await database.select().from(s.utilityBalances)) expect(b.balance).toBeGreaterThanOrEqual(0);
    expect((await balance(DEMO_ACCOUNTS.electricity)).balance).toBe(0); // 8 kWh is ~1 day
  });

  it("speeds up consumption with the usage multiplier", async () => {
    // Start with plenty of data so neither run is capped by an empty balance.
    const topUp = (db: Database) => db.update(s.utilityBalances).set({ balance: 1_000 }).where(eq(s.utilityBalances.accountId, DEMO_ACCOUNTS.data));
    await topUp(database);
    await setUsageMultiplier(database, DEMO_HOUSEHOLD_ID, "data", 3);
    await advanceTime(database, DEMO_HOUSEHOLD_ID, 2);
    const fast = 1_000 - (await balance(DEMO_ACCOUNTS.data)).balance;
    const other = await freshDatabase();
    await topUp(other);
    await advanceTime(other, DEMO_HOUSEHOLD_ID, 2);
    const normal = 1_000 - (await other.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, DEMO_ACCOUNTS.data)))[0]!.balance;
    expect(fast).toBeCloseTo(normal * 3, 1);
  });

  it("forfeits remaining data when the bundle expires", async () => {
    await database.update(s.utilityBalances).set({ balance: 5_000, expiresAt: new Date(Date.UTC(2026, 10, 14, 8)) }).where(eq(s.utilityBalances.accountId, DEMO_ACCOUNTS.data));
    const r = await advanceTime(database, DEMO_HOUSEHOLD_ID, 3);
    expect((await balance(DEMO_ACCOUNTS.data)).balance).toBe(0);
    expect(r.expiredBundles).toHaveLength(1);
  });
});

describe("agent run (no payment execution)", () => {
  it("persists a complete, auditable decision before creating purchases", async () => {
    const r = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    const [d] = await database.select().from(s.agentDecisions).where(eq(s.agentDecisions.id, r.decisionId));
    expect(d).toBeDefined();
    expect(d!.reasoning.length).toBeGreaterThan(40);
    expect(d!.inputSnapshot).toHaveProperty("utilities");
    expect(d!.candidates).toBeInstanceOf(Array);
    expect(d!.budgetImpact).toHaveProperty("remainingAfterNgn");
    expect(d!.outcome).toBe(r.decision.outcome);

    const ps = await purchases();
    expect(ps.length).toBe(r.decision.selected.length);
    for (const p of ps) {
      expect(p.decisionId).toBe(r.decisionId);
      expect(p.initiatedBy).toBe("agent");
      expect(p.idempotencyKey).toBe(`${r.decisionId}:${p.kind}`);
    }
  });

  it("on the demo household: sees both shortages and acts within budget", async () => {
    const r = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    const needs = r.decision.assessments.filter((a) => a.needsAction).map((a) => a.kind).sort();
    expect(needs).toEqual(["data", "electricity"]);
    expect(r.decision.budgetImpact.plannedNgn).toBeLessThanOrEqual(8_000);
    expect(r.decision.selected.length).toBeGreaterThan(0);
  });

  it("a second run does not duplicate purchases already in progress", async () => {
    const first = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    const second = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    expect(second.decision.selected).toEqual([]);
    expect(second.decision.deferred.every((d) => d.reason === "purchase_in_progress")).toBe(true);
    expect((await purchases()).length).toBe(first.decision.selected.length);
  });

  it("takes no purchasing action when automatic purchasing is disabled", async () => {
    await database.update(s.agentPolicies).set({ autoPurchaseEnabled: false });
    const r = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    expect(r.decision.outcome).toBe("blocked");
    expect(await purchases()).toHaveLength(0);
  });

  it("writes a readable timeline: predictions, then the decision", async () => {
    const r = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    const events = await database.select().from(s.activityEvents).where(eq(s.activityEvents.decisionId, r.decisionId));
    const cats = events.map((e) => e.category);
    expect(cats).toContain("prediction");
    expect(cats).toContain("decision");
    expect(events.find((e) => e.type.startsWith("decision."))?.title).toBe(r.explanation.headline);
  });
});

describe("approval flow", () => {
  beforeEach(async () => {
    await database.update(s.agentPolicies).set({ manualApprovalThresholdNgn: 1_000 });
  });

  it("parks purchases above the threshold and only pays after approval", async () => {
    const fetchImpl = vi.fn(async (_url: string) => new Response("{}", { status: 503 }));
    const r = await runAgent(database, DEMO_HOUSEHOLD_ID, { buyer: { fetchImpl: fetchImpl as unknown as typeof fetch } });
    expect(r.awaitingApproval.length).toBeGreaterThan(0);

    const id = r.awaitingApproval[0]!;
    const [parked] = await database.select().from(s.purchases).where(eq(s.purchases.id, id));
    expect(parked).toMatchObject({ stage: "awaiting_approval", paymentStatus: "not_started" });
    // Purchases under the threshold may proceed, but the parked one never contacted its provider.
    const calledUrls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(calledUrls.some((u) => u.includes(`/api/providers/${parked!.providerId}/purchase`))).toBe(false);

    await approvePurchase(database, id);
    expect((await database.select().from(s.purchases).where(eq(s.purchases.id, id)))[0]!.stage).toBe("requested");
  });

  it("decline cancels without paying", async () => {
    const r = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    const id = r.awaitingApproval[0]!;
    await declinePurchase(database, id);
    expect((await database.select().from(s.purchases).where(eq(s.purchases.id, id)))[0]).toMatchObject({ stage: "cancelled", paymentStatus: "not_started" });
  });

  it("approval cannot override hard limits that changed since", async () => {
    const r = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    await database.update(s.agentPolicies).set({ perPurchaseLimitNgn: 500 });
    await expect(approvePurchase(database, r.awaitingApproval[0]!)).rejects.toThrow(/per-purchase limit/);
  });
});
