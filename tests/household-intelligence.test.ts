/**
 * Household intelligence (upgrade M4). Proves:
 *  - forecasts state their confidence, the history they used and their assumptions;
 *  - every decision records the options considered, why each was rejected, and the
 *    expected household impact of the choice;
 *  - "no purchase needed" is an explicit, recorded outcome, and code refuses an
 *    unnecessary agent purchase regardless of what the model asks for;
 *  - the owner's per-utility caps and reserve shape the allocation;
 *  - the deterministic planner adapts when a provider fails before payment.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { decide } from "@/server/agent/engine";
import { explain } from "@/server/agent/explain";
import { buildDecisionInput, runAgent } from "@/server/agent/run";
import { startAgentRun } from "@/server/agent/runtime/executor";
import { createRun, listRunEvents } from "@/server/agent/runtime/run-log";
import { callTool, type ToolContext } from "@/server/agent/runtime/tools";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID, resetDemo } from "@/server/household/seed";
import { providerById } from "@/server/providers/registry";
import { handleQuoteRequest } from "@/server/providers/quote-handler";
import { forecast, type UsageSample } from "@/server/usage/forecast";
import { configureTestEnv, freshDatabase } from "./helpers";
import { providerFetch } from "./provider-fetch";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const NOW = new Date("2026-11-14T06:00:00Z");
const hourly = (deltas: number[]): UsageSample[] => deltas.map((delta, i) => ({ simTime: new Date(NOW.getTime() - (deltas.length - 1 - i) * 3_600_000), delta }));
const reading = { kind: "electricity" as const, balance: 8, unit: "kWh" as const, baselinePerHour: 0.32, expiresAt: null };

describe("forecast confidence, history and assumptions", () => {
  it("is high for a full day of steady readings", () => {
    const f = forecast(reading, hourly(Array(24).fill(0.32)), NOW);
    expect(f.confidence.level).toBe("high");
    expect(f.history).toMatchObject({ windowHours: 6, readingsInWindow: 6, readingsLast24h: 24 });
    expect(f.assumptions[0]).toMatch(/observed over the last 6 hours/);
  });
  it("is medium when recent use is erratic", () => {
    expect(forecast(reading, hourly([0.1, 0.9, 0.05, 0.8, 0.1, 0.7, 0.2, 0.9, 0.1, 0.8, 0.1, 0.9]), NOW).confidence.level).toBe("medium");
  });
  it("is low without enough recent history, and says it used the usual rate", () => {
    const f = forecast(reading, hourly([0.3]), NOW);
    expect(f.confidence.level).toBe("low");
    expect(f.rateSource).toBe("baseline");
    expect(f.assumptions[0]).toMatch(/usual rate/);
  });
  it("is at most medium when usage has just changed, and notes it may return to normal", () => {
    const f = forecast(reading, hourly([...Array(18).fill(0.32), ...Array(6).fill(1.0)]), NOW);
    expect(f.unusualUsage).toBe(true);
    expect(f.confidence.level).toBe("medium");
    expect(f.assumptions.join(" ")).toMatch(/returns to normal/);
  });
  it("notes data forfeiture when a bundle expires", () => {
    const f = forecast({ ...reading, kind: "data", unit: "MB", baselinePerHour: 22, balance: 5_000, expiresAt: new Date(NOW.getTime() + 3 * 3_600_000) }, [], NOW);
    expect(f.assumptions.join(" ")).toMatch(/forfeited/);
  });
});

describe("decision records: options considered and rejected", () => {
  it("records every option with a reason, and the expected impact of the choice", async () => {
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    const elec = d.options.find((o) => o.kind === "electricity")!;
    const chosen = elec.considered.filter((o) => o.status === "chosen");
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toMatchObject({ providerId: "prv_demo_powergrid", amountNgn: 4000, reason: null });
    const rejected = elec.considered.filter((o) => o.status === "rejected");
    expect(rejected.length).toBeGreaterThan(4);
    expect(rejected.every((o) => typeof o.reason === "string" && o.reason.length > 5)).toBe(true);
    expect(rejected.find((o) => o.amountNgn === 1000)?.reason).toMatch(/less than the 2-day minimum/);
    expect(rejected.find((o) => o.amountNgn === 5000)?.reason).toMatch(/approval/);
    expect(rejected.find((o) => o.providerId === "prv_demo_electricity" && o.amountNgn === 4000)?.reason).toBe("Same price, less service.");
    expect(elec.impact).toMatchObject({ balanceBefore: 8, balanceAfter: 27, unit: "kWh", costNgn: 4000 });
    expect(elec.impact!.hoursAfter!).toBeGreaterThan(elec.impact!.hoursBefore!);
  });

  it("explains the closest alternatives in plain language", async () => {
    const text = explain(decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID))).reasoning;
    expect(text).toMatch(/Also considered: ₦3,000 from Demo PowerGrid Vend \(cheaper, but gives less service: about \d+ hours vs \d+\)/);
  });

  it("persists options and the not-needed list in the decision record", async () => {
    const r = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    const [row] = await database.select().from(s.agentDecisions).where(eq(s.agentDecisions.id, r.decisionId));
    const sel = row!.selectedAction as { options: { kind: string; considered: unknown[] }[]; notNeeded: { kind: string; reason: string }[] };
    expect(sel.options.map((o) => o.kind).sort()).toEqual(["data", "electricity"]);
    expect(sel.notNeeded).toEqual([expect.objectContaining({ kind: "airtime", reason: expect.stringMatching(/keeps watching/) })]);
  });

  it("states 'no purchase needed' for comfortable utilities", async () => {
    await resetDemo(database, "unusual-data");
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.notNeeded.map((n) => n.kind).sort()).toEqual(["airtime", "electricity"]);
    expect(explain(d).reasoning).toMatch(/Airtime doesn't need a purchase \(about 12 days left\)/);
  });
});

describe("owner's allocation rules", () => {
  it("a per-utility cap sizes the purchase down", async () => {
    await database.update(s.agentPolicies).set({ maxPerUtilityNgn: { electricity: 3_000 } });
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected.find((p) => p.kind === "electricity")?.product.amountNgn).toBe(3000);
    const elec = d.options.find((o) => o.kind === "electricity")!;
    expect(elec.considered.find((o) => o.amountNgn === 4000)?.reason).toMatch(/electricity/i);
  });
  it("a reserve keeps money back from the agent", async () => {
    await database.update(s.agentPolicies).set({ reserveNgn: 7_000 }); // ₦8,000 left → ₦1,000 usable
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected.reduce((t, p) => t + p.product.amountNgn, 0)).toBeLessThanOrEqual(1_000);
  });
});

describe("necessity guard (code refuses unnecessary agent purchases)", () => {
  const ctx = (): ToolContext => ({ db: database, runId: "run_test", householdId: DEMO_HOUSEHOLD_ID, quotes: new Map(), purchaseIds: [], walletBalance: async () => 100_000_000n, buyer: { fetchImpl: providerFetch().fetchImpl } });
  beforeEach(async () => {
    const id = await createRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "ai", model: "t", task: "t", trigger: "manual", simTime: new Date() });
    await database.update(s.agentRuns).set({ id: "run_test" }).where(eq(s.agentRuns.id, id));
  });

  it("refuses to buy a utility with plenty of service left", async () => {
    await database.update(s.utilityBalances).set({ balance: 5_000 }).where(eq(s.utilityBalances.accountId, DEMO_ACCOUNTS.airtime));
    const c = ctx();
    const q = (await callTool(c, "request_quote", { utility: "airtime", provider_id: "prv_demo_airtime", product_code: "air_500" })) as { quote_id: string };
    expect(await callTool(c, "propose_purchase", { quote_id: q.quote_id, reason: "Just in case." })).toMatchObject({ needed: false });
    const r = (await callTool(c, "purchase_utility", { quote_id: q.quote_id, reason: "Just in case." })) as { status: string; reason: string };
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/not needed/);
    expect(await database.select().from(s.purchases)).toHaveLength(0);
    expect((await listRunEvents(database, "run_test")).some((e) => e.type === "purchase.not_needed")).toBe(true);
  });

  it("refuses to buy more of a utility whose usage is flagged as unusual", async () => {
    await resetDemo(database, "unusual-data");
    const id = await createRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "ai", model: "t", task: "t", trigger: "manual", simTime: new Date() });
    await database.update(s.agentRuns).set({ id: "run_test" }).where(eq(s.agentRuns.id, id));
    const c = ctx();
    const q = (await callTool(c, "request_quote", { utility: "data", provider_id: "prv_demo_data", product_code: "data_1_5gb_30d" })) as { quote_id: string };
    const r = (await callTool(c, "purchase_utility", { quote_id: q.quote_id, reason: "Running out fast." })) as { status: string; reason: string };
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/owner's review/);
  });

  it("allows a utility that genuinely needs it", async () => {
    const c = ctx();
    const q = (await callTool(c, "request_quote", { utility: "electricity", provider_id: "prv_demo_powergrid", product_code: "elec_3000" })) as { quote_id: string };
    expect(await callTool(c, "propose_purchase", { quote_id: q.quote_id, reason: "Low meter." })).toMatchObject({ needed: true, outcome: "would be allowed" });
  });
});

describe("adaptive deterministic planner", () => {
  it("re-decides without a provider that fails to quote, and stops before paying when the fallback also fails", async () => {
    await resetDemo(database, "provider-outage");
    await database.update(s.utilityProviders).set({ available: true }); // the DB thinks PowerGrid is up…
    const pf = providerFetch({
      // …but its endpoint is down when the agent asks for a quote.
      quote: async (request) => {
        const id = new URL(request.url).pathname.split("/")[3]!;
        if (id === "prv_demo_powergrid") return new Response(JSON.stringify({ code: "provider_unavailable", message: "Provider is temporarily unavailable." }), { status: 503 });
        return handleQuoteRequest(providerById(id)!, request);
      },
    });
    const { runId, done } = await startAgentRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", walletBalance: async () => 0n, buyer: { fetchImpl: pf.fetchImpl } });
    expect((await done).status).toBe("completed");
    const events = await listRunEvents(database, runId);
    const quoted = pf.quotes().map((q) => q.url.split("/")[3]);
    expect(quoted).toEqual(["prv_demo_powergrid", "prv_demo_electricity"]);
    const adapted = events.filter((e) => e.type === "planner.adapted");
    expect(adapted.map((e) => e.decision)).toEqual(["try_alternative", "give_up"]);
    expect(adapted[0]!.reason).toMatch(/Demo PowerGrid Vend could not complete the purchase .* Nothing was charged\. Trying .* from Demo Prepaid Electricity instead\./);
    // The fallback stopped before signing (empty wallet) — never charged twice, never signed.
    expect(events.some((e) => e.type === "payment.signing")).toBe(false);
    const purchases = await database.select().from(s.purchases);
    expect(purchases).toEqual([expect.objectContaining({ providerId: "prv_demo_electricity", stage: "failed", paymentStatus: "failed" })]);
  });
});

describe("settings: allocation rules", () => {
  it("saves daily, per-run, reserve and per-utility caps, and leaves them alone when omitted", async () => {
    const { updateSettings } = await import("@/server/settings");
    const { loadHousehold } = await import("@/server/household/state");
    const base = {
      householdName: "Okafor Household",
      budgetAmountNgn: 15_000,
      budgetPeriod: "monthly" as const,
      autoPurchaseEnabled: true,
      perPurchaseLimitNgn: 5_000,
      overallAgentLimitNgn: 8_000,
      manualApprovalThresholdNgn: 4_500,
      priorities: ["electricity", "data", "airtime"] as ("electricity" | "data" | "airtime")[],
      approvedServices: ["electricity", "airtime", "data"] as ("electricity" | "data" | "airtime")[],
      approvedNetworks: ["mtn"] as "mtn"[],
    };
    await updateSettings(database, DEMO_HOUSEHOLD_ID, { ...base, dailyAgentBudgetNgn: 5_000, taskBudgetNgn: 4_000, reserveNgn: 1_000, maxPerUtilityNgn: { electricity: 3_000, airtime: 0, data: 2_000 } });
    let p = (await loadHousehold(database, DEMO_HOUSEHOLD_ID)).policy;
    expect(p).toMatchObject({ dailyAgentBudgetNgn: 5_000, taskBudgetNgn: 4_000, reserveNgn: 1_000, maxPerUtilityNgn: { electricity: 3_000, data: 2_000 } });
    expect(p.maxPerUtilityNgn).not.toHaveProperty("airtime"); // ₦0 = no cap

    await updateSettings(database, DEMO_HOUSEHOLD_ID, base);
    p = (await loadHousehold(database, DEMO_HOUSEHOLD_ID)).policy;
    expect(p).toMatchObject({ dailyAgentBudgetNgn: 5_000, reserveNgn: 1_000 });
    const [ev] = await database.select().from(s.activityEvents).where(eq(s.activityEvents.type, "settings.updated"));
    expect(ev!.detail).toMatch(/daily agent limit ₦5,000/);
  });
});
