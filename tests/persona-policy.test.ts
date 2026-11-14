/**
 * The shipped demo persona and the product brief's scenarios, against a real (temporary) database:
 *  - the household owner's USDC limits are seeded, configurable and enforced in code;
 *  - Scenario A: Simulate low balance lowers the persisted meter, records it, and the engine buys
 *    2 USDC of electricity automatically from an eligible vendor;
 *  - Scenario B: with 2 USDC left, electricity and data compete and priorities decide;
 *  - Scenario C: an instructed over-limit purchase is refused by the wallet's rules, unsigned;
 *  - owner controls: pause, resume, emergency stop.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { agentControlState, controlAgent } from "@/server/agent/control";
import { decide } from "@/server/agent/engine";
import { explain } from "@/server/agent/explain";
import { AgentPausedError, buildDecisionInput, runAgent } from "@/server/agent/run";
import { startAgentRun } from "@/server/agent/runtime/executor";
import { listRunEvents } from "@/server/agent/runtime/run-log";
import { callTool, type ToolContext } from "@/server/agent/runtime/tools";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { simulateLowBalance } from "@/server/demo/low-balance";
import { evaluateSpendingAuthority, type PurchaseLedgerEntry } from "@/server/household/policy";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID, resetDemo } from "@/server/household/seed";
import { loadHousehold } from "@/server/household/state";
import { createElectricityProvider, DEMO_DISCO } from "@/server/providers/electricity";
import { airtimeProviderB } from "@/server/providers/airtime";
import { eligibilityFor } from "@/server/providers/registry";
import { createPurchase } from "@/server/transactions/purchases";
import { configureTestEnv, freshDatabase } from "./helpers";
import { providerFetch } from "./provider-fetch";

let database: Database;
beforeEach(async () => {
  configureTestEnv({ DEMO_NGN_PER_TESTNET_USDC: "1000" });
  database = await freshDatabase({ persona: true });
  await resetDemo(database, "primary-electricity");
});

const USDC = 10_000_000n; // atomic units per test USDC
const intent = (amountNgn: number, o: Partial<Parameters<typeof evaluateSpendingAuthority>[0]> = {}) => ({
  kind: "electricity" as const,
  providerId: "prv_demo_powergrid",
  providerAvailable: true,
  network: null,
  amountNgn,
  initiatedBy: "agent" as const,
  ...o,
});
async function authority(amountNgn: number, o: { ledger?: PurchaseLedgerEntry[]; intent?: Partial<Parameters<typeof evaluateSpendingAuthority>[0]>; walletUsdc?: bigint; runId?: string } = {}) {
  const st = await loadHousehold(database, DEMO_HOUSEHOLD_ID);
  return evaluateSpendingAuthority(intent(amountNgn, o.intent), st.policy, st.budget, o.ledger ?? st.ledger, st.household.simulatedNow, undefined, {
    runId: o.runId,
    wallet: { availableAtomic: o.walletUsdc ?? 20n * USDC, requiredAtomic: (BigInt(amountNgn) * USDC) / 1000n },
  });
}
const codes = (r: { violations: { code: string }[] }) => r.violations.map((v) => v.code);

describe("household owner persona", () => {
  it("seeds the brief's USDC limits (at ₦1,000 = 1 test USDC)", async () => {
    const [p] = await database.select().from(s.agentPolicies);
    const [hh] = await database.select().from(s.households);
    const [owner] = await database.select().from(s.householdMembers);
    expect(hh!.name).toBe("Okafor Household");
    expect(owner).toMatchObject({ name: "Adaeze Okafor", role: "owner" });
    expect(p).toMatchObject({
      manualApprovalThresholdNgn: 2_000, // automatic up to 2 USDC per request; approval above
      perPurchaseLimitNgn: 4_000, // never more than 4 USDC in one request, even with approval
      taskBudgetNgn: 4_000, // 4 USDC per agent task
      dailyAgentBudgetNgn: 10_000, // 10 USDC per day
      autoPurchaseEnabled: true,
      agentPaused: false,
    });
  });

  it("2 USDC is automatic; above 2 USDC needs approval; above 4 USDC is refused even if approved", async () => {
    expect((await authority(2_000)).outcome).toBe("allow");
    expect((await authority(3_000)).outcome).toBe("require_approval");
    const over = await authority(5_000, { intent: { ownerApproved: true } });
    expect(over.outcome).toBe("deny");
    expect(codes(over)).toContain("exceeds_per_purchase_limit");
  });

  it("enforces the per-task budget across one run's purchases", async () => {
    const st = await loadHousehold(database, DEMO_HOUSEHOLD_ID);
    const prior: PurchaseLedgerEntry = { id: "pur_a", amountNgn: 3_000, initiatedBy: "agent", stage: "completed", paymentStatus: "confirmed", createdAt: st.household.simulatedNow, runId: "run_task" };
    const r = await authority(2_000, { ledger: [...st.ledger, prior], runId: "run_task" });
    expect(r.outcome).toBe("deny");
    expect(codes(r)).toContain("exceeds_task_budget");
  });

  it("enforces the daily budget, counting pending commitments", async () => {
    const st = await loadHousehold(database, DEMO_HOUSEHOLD_ID);
    const today = (id: string, amountNgn: number, paymentStatus: PurchaseLedgerEntry["paymentStatus"], stage: PurchaseLedgerEntry["stage"]): PurchaseLedgerEntry => ({ id, amountNgn, initiatedBy: "agent", stage, paymentStatus, createdAt: st.household.simulatedNow, runId: null });
    const ledger = [today("p1", 4_000, "confirmed", "completed"), today("p2", 4_000, "confirmed", "completed"), today("p3", 1_500, "requires_payment", "payment_required")];
    const r = await authority(1_000, { ledger: [...st.ledger, ...ledger] });
    expect(r.outcome).toBe("deny");
    expect(codes(r)).toContain("exceeds_daily_budget");
  });

  it("can't spend more than the wallet holds, whatever the policy allows", async () => {
    const r = await authority(2_000, { walletUsdc: 1n * USDC });
    expect(r.outcome).toBe("deny");
    expect(codes(r)).toContain("insufficient_wallet_balance");
  });

  it("refuses unapproved providers and a revoked authority", async () => {
    await database.update(s.agentPolicies).set({ approvedProviderIds: ["prv_demo_electricity"] });
    expect(codes(await authority(2_000))).toContain("provider_not_approved");
    await database.update(s.agentPolicies).set({ autoPurchaseEnabled: false });
    expect(codes(await authority(2_000, { intent: { providerId: "prv_demo_electricity" } }))).toContain("agent_disabled");
  });

  it("limits are configurable: a lower approval threshold parks the same purchase", async () => {
    await database.update(s.agentPolicies).set({ manualApprovalThresholdNgn: 1_000 });
    expect((await authority(2_000)).outcome).toBe("require_approval");
  });
});

describe("Scenario A — primary electricity demo", () => {
  it("Simulate low balance lowers the persisted meter, records it, and leaves supply to the agent", async () => {
    const r = await simulateLowBalance(database, DEMO_HOUSEHOLD_ID, { startRun: false });
    expect(r).toMatchObject({ kind: "electricity", balanceBefore: 20, unit: "kWh", runId: null });
    expect(r.balanceAfter).toBeGreaterThan(7); // ~24 h at about 0.32 kWh/h
    expect(r.balanceAfter).toBeLessThan(8.5);
    expect(r.hoursLeft).toBeCloseTo(24, 0);
    const [bal] = await database.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, DEMO_ACCOUNTS.electricity));
    expect(bal!.balance).toBe(r.balanceAfter);
    const [ev] = await database.select().from(s.activityEvents).where(eq(s.activityEvents.type, "demo.low_balance"));
    expect(ev?.detail).toContain(`20 → ${r.balanceAfter} kWh`);
  });

  it("is repeatable and never adds supply", async () => {
    const a = await simulateLowBalance(database, DEMO_HOUSEHOLD_ID, { startRun: false });
    const b = await simulateLowBalance(database, DEMO_HOUSEHOLD_ID, { startRun: false });
    expect(b.balanceAfter).toBeLessThanOrEqual(a.balanceAfter);
    await resetDemo(database, "primary-electricity");
    expect((await simulateLowBalance(database, DEMO_HOUSEHOLD_ID, { startRun: false })).balanceAfter).toBe(a.balanceAfter);
  });

  it("the engine then buys 2 USDC of electricity automatically, from an eligible vendor, and nothing else", async () => {
    await simulateLowBalance(database, DEMO_HOUSEHOLD_ID, { startRun: false });
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected).toHaveLength(1);
    expect(d.selected[0]).toMatchObject({ kind: "electricity", requiresApproval: false, product: { amountNgn: 2_000, providerId: "prv_demo_powergrid" } });
    expect(d.selected[0]!.coverageHours).toBeGreaterThanOrEqual(48);
  });

  it("before the simulation nothing is urgent, so nothing is bought", async () => {
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected).toHaveLength(0);
  });
});

describe("Scenario B — competing needs with 2 USDC left", () => {
  beforeEach(() => resetDemo(database, "budget-covers-one"));

  it("electricity first (the owner's priority): buys it, defers data, and explains all eight points", async () => {
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected.map((p) => p.kind)).toEqual(["electricity"]);
    expect(d.selected[0]!.product.amountNgn).toBeLessThanOrEqual(2_000);
    expect(d.deferred.map((x) => x.kind)).toContain("data");
    const e = explain(d);
    const text = [e.headline, e.reasoning, ...e.lines.map((l) => l.text)].join(" ");
    expect(text).toMatch(/electricity/i); // what it observed and selected
    expect(text).toMatch(/data/i); // the competing need, and what it deferred
    expect(text).toMatch(/priorit/i); // what the household's priorities say
    expect(text).toMatch(/₦\d/); // what the options cost
    expect(text).toMatch(/left|remaining/i); // what the household has left afterwards
    expect(d.budgetImpact.remainingAfterNgn).toBe(d.budgetImpact.remainingBeforeNgn - d.budgetImpact.plannedNgn);
  });

  it("the outcome follows the inputs: with data first in the owner's priorities, the money goes to data", async () => {
    await database.update(s.agentPolicies).set({ priorities: ["data", "electricity", "airtime"] });
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected.map((p) => p.kind)).toContain("data");
    expect(d.deferred.map((x) => x.kind)).toContain("electricity");
  });

  it("with no money left at all, it buys nothing and says why", async () => {
    await database.update(s.householdBudgets).set({ priorSpendNgn: 100_000 });
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected).toHaveLength(0);
    expect(d.deferred.length).toBeGreaterThan(0);
    expect(d.deferred.every((x) => x.reason === "insufficient_budget")).toBe(true);
  });
});

describe("Scenario C — the wallet refuses an over-limit purchase", () => {
  it("an instructed 5 USDC purchase is refused by the spending rules before any payment request", async () => {
    await resetDemo(database, "policy-rejection");
    const pf = providerFetch();
    const { runId, done } = await startAgentRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", directive: { kind: "electricity", amountNgn: 5_000 }, buyer: { fetchImpl: pf.fetchImpl }, walletBalance: async () => 20n * USDC });
    const out = await done;
    expect(out.status).toBe("completed");
    expect(out.summary).toMatch(/refused/i);
    const events = await listRunEvents(database, runId);
    const denied = events.filter((e) => e.type === "policy.evaluated" && e.decision === "deny" && !(e.result as { dry_run?: boolean } | null)?.dry_run);
    expect(denied).toHaveLength(1);
    const failed = ((denied[0]!.result as { checks: { key: string; status: string }[] }).checks ?? []).filter((c) => c.status === "fail").map((c) => c.key);
    expect(failed.length).toBeGreaterThan(0);
    expect(denied[0]!.reason).toMatch(/per-request|per purchase|limit/i);
    expect(pf.purchases()).toHaveLength(0); // never even asked the provider for the protected resource
    expect(await database.select().from(s.purchases)).toHaveLength(0); // nothing to sign
  });
});

describe("other scenarios still demonstrate what they're for under the persona", () => {
  it("provider outage: falls back to the other eligible vendor, automatically", async () => {
    await resetDemo(database, "provider-outage");
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected[0]).toMatchObject({ kind: "electricity", requiresApproval: false, product: { providerId: "prv_demo_electricity" } });
  });

  it("empty wallet: the purchase is automatic, so it reaches the provider's 402 and stops at the wallet", async () => {
    await resetDemo(database, "empty-wallet");
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected[0]).toMatchObject({ kind: "electricity", requiresApproval: false });
  });

  it("both low: two purchases fit inside the 4 USDC task budget", async () => {
    await resetDemo(database, "both-low");
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected.map((p) => p.kind).sort()).toEqual(["data", "electricity"]);
    expect(d.selected.reduce((t, p) => t + p.product.amountNgn, 0)).toBeLessThanOrEqual(4_000);
    expect(d.selected.every((p) => !p.requiresApproval)).toBe(true);
  });
});

describe("owner controls", () => {
  it("pause stops new runs and assessments; resume restores them", async () => {
    await controlAgent(database, DEMO_HOUSEHOLD_ID, "pause");
    await expect(startAgentRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic" })).rejects.toBeInstanceOf(AgentPausedError);
    await expect(runAgent(database, DEMO_HOUSEHOLD_ID, { execute: false })).rejects.toBeInstanceOf(AgentPausedError);
    const low = await simulateLowBalance(database, DEMO_HOUSEHOLD_ID);
    expect(low.runId).toBeNull();
    expect(low.runNotStarted?.code).toBe("agent_paused");
    expect(codes(await authority(2_000))).toContain("agent_paused");
    await controlAgent(database, DEMO_HOUSEHOLD_ID, "resume");
    expect((await agentControlState(database, DEMO_HOUSEHOLD_ID)).paused).toBe(false);
    expect((await authority(2_000)).outcome).toBe("allow");
  });

  it("a run in progress stops at its next step when the owner pauses", async () => {
    await simulateLowBalance(database, DEMO_HOUSEHOLD_ID, { startRun: false });
    const pf = providerFetch({
      quote: async () => {
        await controlAgent(database, DEMO_HOUSEHOLD_ID, "pause"); // the owner pauses while the agent is quoting
        return Response.json({ code: "provider_unavailable" }, { status: 503 });
      },
    });
    const { runId, done } = await startAgentRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", buyer: { fetchImpl: pf.fetchImpl }, walletBalance: async () => 20n * USDC });
    const out = await done;
    expect(out.summary).toMatch(/Stopped by the owner/);
    expect((await listRunEvents(database, runId)).some((e) => e.type === "run.stopped")).toBe(true);
    expect(pf.purchases()).toHaveLength(0);
  });

  it("emergency stop pauses, revokes purchasing, and declines pending approvals unpaid", async () => {
    const parked = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_powergrid", amountNgn: 3_000, initiatedBy: "agent" });
    expect(parked.stage).toBe("awaiting_approval");
    const r = await controlAgent(database, DEMO_HOUSEHOLD_ID, "emergency_stop");
    expect(r).toMatchObject({ paused: true, autoPurchaseEnabled: false, declinedApprovals: [parked.id] });
    const [p] = await database.select().from(s.purchases).where(eq(s.purchases.id, parked.id));
    expect(p).toMatchObject({ stage: "cancelled", paymentStatus: "not_started" });
  });
});

describe("eligibility — no manufactured alternatives", () => {
  it("a meter can only be recharged through vendors authorised for its DisCo", () => {
    const other = createElectricityProvider({ id: "prv_other", name: "Other DisCo Vend", payToEnv: "X", tariffNgnPerKwh: 200, serviceFeeNgn: 0, distributionCompanies: ["Demo Abuja DisCo"], minAmountNgn: 1_000, maxAmountNgn: 5_000, stepNgn: 500, offerSummary: "" });
    const meter = { kind: "electricity" as const, network: null, distributionCompany: DEMO_DISCO };
    const r = eligibilityFor(other, meter);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/served by Demo Eko DisCo/);
  });

  it("airtime only on the line's own network", () => {
    expect(eligibilityFor(airtimeProviderB, { kind: "airtime", network: "glo", distributionCompany: null })).toMatchObject({ eligible: false });
  });

  it("search_offers and read_price_list report only eligible offers, priced in test USDC", async () => {
    const id = "run_test_tools";
    const ctx: ToolContext = { db: database, runId: id, householdId: DEMO_HOUSEHOLD_ID, quotes: new Map(), purchaseIds: [], buyer: { fetchImpl: providerFetch().fetchImpl } };
    await database.insert(s.agentRuns).values({ id, householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", task: "t", trigger: "manual", status: "running", simTime: new Date(), startedAt: new Date() });
    const found = (await callTool(ctx, "search_offers", { utility: "electricity", max_price_usdc: 2 })) as { offers: { provider_id: string; price_ngn: number; price_usdc: string }[]; excluded: unknown[] };
    expect(found.offers.length).toBeGreaterThan(0);
    expect(found.offers.every((o) => o.price_ngn <= 2_000)).toBe(true);
    expect(found.offers.find((o) => o.price_ngn === 2_000)?.price_usdc).toBe("2.00");
    const list = (await callTool(ctx, "read_price_list", { provider_id: "prv_demo_powergrid" })) as { eligible_for_this_household: boolean; eligibility: string; price_list: { price_usdc: string }[] };
    expect(list).toMatchObject({ eligible_for_this_household: true });
    expect(list.eligibility).toMatch(/Demo Eko DisCo/);
  });
});
