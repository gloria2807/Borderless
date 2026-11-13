/**
 * Procurement decisions (amendment A3). Proves:
 *  - the agent buys information only when it could change a purchase that matters
 *    (value of information), compares information offers, and records why;
 *  - it declines to buy information when the need isn't urgent, the price isn't justified,
 *    or the household's limits leave nothing the information could change;
 *  - it acts on the paid report: genuine extra use → sized purchase; avoidable use → minimal
 *    relief only (or nothing) and an action for the owner;
 *  - code enforces the same in the agent's tools, whatever the model asks for.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { decide, VALUE_OF_INFORMATION_SHARE, type Diagnosis } from "@/server/agent/engine";
import { explain } from "@/server/agent/explain";
import { buildDecisionInput, runAgent } from "@/server/agent/run";
import { startAgentRun } from "@/server/agent/runtime/executor";
import { createRun, listRunEvents } from "@/server/agent/runtime/run-log";
import { callTool, type ToolContext } from "@/server/agent/runtime/tools";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID, resetDemo } from "@/server/household/seed";
import { newId } from "@/server/lib/ids";
import { configureTestEnv, freshDatabase } from "./helpers";
import { providerFetch } from "./provider-fetch";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const decideFor = async (scenario: string, diagnoses?: Partial<Record<"electricity", Diagnosis>>) => {
  await resetDemo(database, scenario);
  const input = await buildDecisionInput(database, DEMO_HOUSEHOLD_ID);
  const d = decide(diagnoses ? { ...input, diagnoses } : input);
  return { d, e: explain(d), input };
};

const dx = (finding: Diagnosis["finding"], observed = 1.02, normal = 0.32): Diagnosis => ({
  purchaseId: "pur_x",
  providerId: "prv_demo_gridsense",
  finding,
  summary: finding === "stuck_load" ? "The water heater appears to be stuck on." : finding === "extra_occupancy" ? "More people in the home, not a fault." : "Meter over-reading.",
  ownerAction: finding === "extra_occupancy" ? null : "Fix it.",
  expectedNormalPerHour: finding === "extra_occupancy" ? observed : normal,
  observedPerHour: observed,
});

/** Store a completed diagnostic with its receipt, as a real paid purchase would leave it. */
async function storeDiagnosis(result: Record<string, unknown>, hoursAgo = 1) {
  const [hh] = await database.select().from(s.households).where(eq(s.households.id, DEMO_HOUSEHOLD_ID));
  const id = newId("pur");
  await database.insert(s.purchases).values({
    id,
    householdId: DEMO_HOUSEHOLD_ID,
    accountId: DEMO_ACCOUNTS.electricity,
    providerId: "prv_demo_gridsense",
    kind: "electricity",
    productCode: "meter_diagnostic",
    serviceType: "meter_diagnostic",
    amountNgn: 300,
    quantity: 1,
    unit: "report",
    idempotencyKey: id,
    initiatedBy: "agent",
    stage: "completed",
    paymentStatus: "confirmed",
    fulfilmentStatus: "fulfilled",
    simTime: new Date(hh!.simulatedNow.getTime() - hoursAgo * 3_600_000),
  });
  await database.insert(s.receipts).values({ id: newId("rcp"), purchaseId: id, providerReceiptId: "rcp_x", payload: { fulfilment: { status: "fulfilled", details: { result: { service: "meter_diagnostic", ...result } } } } });
  return id;
}

describe("value of information", () => {
  it("buys a cheap diagnostic before an electricity purchase it could change, and compares offers", async () => {
    const { d, e } = await decideFor("electricity-surge");
    expect(d.outcome).toBe("buying_information");
    expect(d.selected.filter((p) => p.kind === "electricity")).toHaveLength(0);
    expect(d.deferred).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "electricity", reason: "awaiting_diagnosis" })]));
    const info = d.information.find((i) => i.kind === "electricity")!;
    expect(info).toMatchObject({ action: "buy", providerId: "prv_demo_gridsense", priceNgn: 300 });
    expect(info.priceNgn!).toBeLessThanOrEqual(info.stakeNgn! * VALUE_OF_INFORMATION_SHARE);
    expect(info.alternatives).toEqual([expect.objectContaining({ providerId: "prv_demo_meterlab", why: expect.stringMatching(/Costs ₦500 more/) })]);
    expect(e.headline).toMatch(/Checking unusual electricity use first/);
    expect(e.reasoning).toMatch(/Buying a diagnostic from Demo GridSense Diagnostics for ₦300/);
  });

  it("declines when the need isn't urgent: no purchase depends on the cause yet", async () => {
    const { d, e } = await decideFor("surge-not-urgent");
    expect(d.information).toEqual([expect.objectContaining({ kind: "electricity", action: "not_worth_it", code: "not_urgent" })]);
    expect(d.selected).toHaveLength(0);
    expect(e.reasoning).toMatch(/Not buying a diagnostic/);
  });

  it("declines when the household's limits leave nothing the information could change", async () => {
    const { d } = await decideFor("surge-tight-budget");
    expect(d.information).toEqual([expect.objectContaining({ kind: "electricity", action: "not_worth_it", code: "outside_limits" })]);
    expect(d.outcome).not.toBe("buying_information");
  });

  it("declines when the price isn't justified by the purchase at stake", async () => {
    await resetDemo(database, "electricity-surge");
    const input = await buildDecisionInput(database, DEMO_HOUSEHOLD_ID);
    const pricey = { electricity: input.informationOffers!.electricity!.map((o) => ({ ...o, priceNgn: 4_000 })) };
    const d = decide({ ...input, informationOffers: pricey, policy: { ...input.policy, intelligenceCapNgn: 10_000 } });
    expect(d.information[0]).toMatchObject({ action: "not_worth_it", code: "too_expensive" });
  });

  it("respects the owner's rules for information: not approved, unavailable, or over the cap", async () => {
    await resetDemo(database, "electricity-surge");
    await database.update(s.agentPolicies).set({ intelligenceCapNgn: 200 });
    const input = await buildDecisionInput(database, DEMO_HOUSEHOLD_ID);
    const d = decide(input);
    expect(d.information[0]).toMatchObject({ action: "not_worth_it", code: "outside_limits" });
    expect(d.deferred).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "electricity", reason: "unusual_usage" })]));
  });

  it("picks the other provider when the cheaper one is down", async () => {
    await resetDemo(database, "electricity-surge");
    await database.update(s.utilityProviders).set({ available: false }).where(eq(s.utilityProviders.id, "prv_demo_gridsense"));
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    const info = d.information[0]!;
    expect(info).toMatchObject({ action: "buy", providerId: "prv_demo_meterlab", priceNgn: 800 });
    expect(info.alternatives?.[0]?.why).toMatch(/unavailable/i);
  });
});

describe("acting on the paid report", () => {
  it("avoidable use (stuck heater) and a nearly empty meter → minimal relief sized for the normal rate", async () => {
    const before = await decideFor("electricity-surge");
    const unexplainedStake = before.d.information[0]!.stakeNgn!;
    const { d, e } = await decideFor("electricity-surge", { electricity: dx("stuck_load") });
    const elec = d.selected.find((p) => p.kind === "electricity")!;
    expect(elec).toMatchObject({ basis: "diagnosed_minimum" });
    expect(elec.product.amountNgn).toBeLessThan(unexplainedStake); // buys less than it would have blind
    expect(d.information[0]).toMatchObject({ action: "diagnosed", code: "avoidable_use" });
    expect(e.reasoning).toMatch(/enough for about two days at the normal rate/);
    expect(e.reasoning).toMatch(/not buying for the current rate/);
  });

  it("avoidable use with enough left → no purchase, fix the cause", async () => {
    const { d, e } = await decideFor("surge-not-urgent", { electricity: dx("stuck_load") });
    expect(d.selected).toHaveLength(0);
    expect(e.reasoning).toMatch(/Diagnostic finding/);
  });

  it("genuine extra use (guests) → a purchase sized for the higher rate", async () => {
    const { d, e } = await decideFor("guests-staying", { electricity: dx("extra_occupancy", 0.84) });
    const elec = d.selected.find((p) => p.kind === "electricity")!;
    expect(elec.basis).not.toBe("diagnosed_minimum");
    expect(d.information[0]).toMatchObject({ action: "diagnosed", code: "genuine_use" });
    expect(e.reasoning).toMatch(/sizing the purchase for the current rate/);
  });

  it("reads the latest paid diagnosis from its receipt, and ignores stale ones", async () => {
    await resetDemo(database, "electricity-surge");
    await storeDiagnosis({ finding: "stuck_load", summary: "Stuck heater.", ownerAction: "Fix.", expectedNormalKwhPerHour: 0.32, observedKwhPerHour: 1.02 }, 30);
    expect((await buildDecisionInput(database, DEMO_HOUSEHOLD_ID)).diagnoses?.electricity).toBeUndefined();
    await storeDiagnosis({ finding: "stuck_load", summary: "Stuck heater.", ownerAction: "Fix.", expectedNormalKwhPerHour: 0.32, observedKwhPerHour: 1.02 }, 1);
    expect((await buildDecisionInput(database, DEMO_HOUSEHOLD_ID)).diagnoses?.electricity).toMatchObject({ finding: "stuck_load", expectedNormalPerHour: 0.32 });
  });
});

describe("planners", () => {
  it("assessment without execution records the decision to buy information first", async () => {
    await resetDemo(database, "electricity-surge");
    const r = await runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false });
    expect(r.decision.outcome).toBe("buying_information");
    expect(r.purchases).toHaveLength(0);
    const [row] = await database.select().from(s.agentDecisions).where(eq(s.agentDecisions.id, r.decisionId));
    expect((row!.selectedAction as { information: { action: string }[] }).information[0]!.action).toBe("buy");
  });

  it("the deterministic planner tries to buy the diagnostic through x402, and stops honestly if it can't pay", async () => {
    await resetDemo(database, "electricity-surge");
    const pf = providerFetch({
      purchase: () =>
        new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "x" }, accepts: [{ scheme: "exact", network: "stellar:testnet", amount: "30000", asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", payTo: process.env.PROVIDER_GRIDSENSE_PAYTO, maxTimeoutSeconds: 300 }] })).toString("base64") },
        }),
    });
    const { runId, done } = await startAgentRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", walletBalance: async () => 0n, buyer: { fetchImpl: pf.fetchImpl } });
    await done;
    const events = await listRunEvents(database, runId);
    const tools = events.filter((e) => e.type === "tool.called").map((e) => e.tool);
    expect(tools).toEqual(expect.arrayContaining(["discover_information_services", "buy_information"]));
    expect(pf.purchases().map((c) => c.url)).toEqual(["/api/services/prv_demo_gridsense/meter-diagnostic"]);
    expect(events.some((e) => e.type === "planner.reassessed")).toBe(false); // no report, no re-decision
    expect(tools).not.toContain("purchase_utility"); // never bought electricity blind
  });

  it("with a report already bought, the planner acts on it: minimal relief for a stuck heater", async () => {
    await resetDemo(database, "electricity-surge");
    await storeDiagnosis({ finding: "stuck_load", summary: "Stuck heater.", ownerAction: "Fix the heater.", expectedNormalKwhPerHour: 0.32, observedKwhPerHour: 1.02 });
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.outcome).toBe("purchase_started");
    expect(d.selected.find((p) => p.kind === "electricity")?.basis).toBe("diagnosed_minimum");
    expect(d.information.filter((i) => i.action === "buy")).toHaveLength(0); // never buys the same information twice
  });
});

describe("tool guard (code, whatever the model asks)", () => {
  async function ctx() {
    const runId = await createRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "ai", model: "t", task: "t", trigger: "manual", simTime: new Date() });
    const c: ToolContext = { db: database, runId, householdId: DEMO_HOUSEHOLD_ID, quotes: new Map(), purchaseIds: [], walletBalance: async () => 100_000_000n, buyer: { fetchImpl: providerFetch().fetchImpl } };
    return c;
  }

  it("refuses to buy electricity blind while the surge is unexplained", async () => {
    await resetDemo(database, "electricity-surge");
    const c = await ctx();
    const q = (await callTool(c, "request_quote", { utility: "electricity", provider_id: "prv_demo_powergrid", product_code: "elec_5000" })) as { quote_id: string };
    const r = (await callTool(c, "purchase_utility", { quote_id: q.quote_id, reason: "Low meter." })) as { status: string; reason: string };
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/cause is unknown/);
  });

  it("after a stuck-heater diagnosis, allows only minimal relief", async () => {
    await resetDemo(database, "electricity-surge");
    await storeDiagnosis({ finding: "stuck_load", summary: "Stuck heater.", ownerAction: "Fix the heater.", expectedNormalKwhPerHour: 0.32, observedKwhPerHour: 1.02 });
    const c = await ctx();
    const big = (await callTool(c, "request_quote", { utility: "electricity", provider_id: "prv_demo_powergrid", product_code: "elec_5000" })) as { quote_id: string };
    const r = (await callTool(c, "purchase_utility", { quote_id: big.quote_id, reason: "Fill up." })) as { status: string; reason: string };
    expect(r).toMatchObject({ status: "refused", reason: expect.stringMatching(/minimal relief/) });
    const plan = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID)).selected.find((p) => p.kind === "electricity")!;
    const small = (await callTool(c, "request_quote", { utility: "electricity", provider_id: plan.product.providerId, product_code: plan.product.code })) as { quote_id: string };
    expect(await callTool(c, "propose_purchase", { quote_id: small.quote_id, reason: "Minimal relief." })).toMatchObject({ needed: true });
  });
});
