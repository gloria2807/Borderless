/**
 * Demo scenarios (upgrade M7). Each is a deterministic starting state; the outcome comes
 * from the real engine, tools and payment path. Proves each scenario shows what it says.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { decide } from "@/server/agent/engine";
import { explain } from "@/server/agent/explain";
import { buildDecisionInput } from "@/server/agent/run";
import { startAgentRun } from "@/server/agent/runtime/executor";
import { createRun, listRunEvents } from "@/server/agent/runtime/run-log";
import { callTool, type ToolContext } from "@/server/agent/runtime/tools";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_INJECTION_TEXT, isFaultEnabled } from "@/server/demo/faults";
import { SCENARIOS } from "@/server/demo/scenarios";
import { DEMO_HOUSEHOLD_ID, resetDemo } from "@/server/household/seed";
import { TESTNET_USDC } from "@/server/payments/pricing";
import { executePurchase } from "@/server/payments/x402-buyer";
import { createPurchase } from "@/server/transactions/purchases";
import { configureTestEnv, freshDatabase, TEST_KEYS } from "./helpers";
import { paymentRequiredHeader, providerFetch } from "./provider-fetch";

let database: Database;
const EMPTY = Keypair.random();
beforeEach(async () => {
  configureTestEnv({ DEMO_EMPTY_WALLET_SECRET: EMPTY.secret(), DEMO_EMPTY_WALLET_PUBLIC: EMPTY.publicKey() });
  database = await freshDatabase();
});

describe("scenario catalogue", () => {
  it("covers the demo cases the brief asks for", () => {
    expect(SCENARIOS.map((x) => x.id)).toEqual(
      expect.arrayContaining(["both-low", "budget-covers-one", "unusual-data", "budget-exhausted", "needs-approval", "provider-outage", "not-urgent", "empty-wallet", "injection-attempt", "authority-revoked"]),
    );
    for (const sc of SCENARIOS) expect(sc.expect.length).toBeGreaterThan(20);
  });

  it("loading a scenario switches exactly its demo faults on, and resetting clears them", async () => {
    await resetDemo(database, "injection-attempt");
    expect(await isFaultEnabled("provider_prompt_injection")).toBe(true);
    expect(await isFaultEnabled("agent_wallet_empty")).toBe(false);
    await resetDemo(database, "both-low");
    expect(await isFaultEnabled("provider_prompt_injection")).toBe(false);
  });
});

describe("not urgent: refusing to buy is a result", () => {
  it("buys nothing and says why each utility can wait", async () => {
    await resetDemo(database, "not-urgent");
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.outcome).toBe("no_action");
    expect(d.selected).toHaveLength(0);
    expect(d.notNeeded.map((n) => n.kind).sort()).toEqual(["airtime", "data", "electricity"]);
    expect(explain(d).reasoning).toMatch(/doesn't need a purchase/);
  });

  it("the deterministic run completes without quoting or paying", async () => {
    await resetDemo(database, "not-urgent");
    const pf = providerFetch();
    const { runId, done } = await startAgentRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", buyer: { fetchImpl: pf.fetchImpl } });
    expect((await done).status).toBe("completed");
    expect(pf.calls).toHaveLength(0);
    expect((await listRunEvents(database, runId)).find((e) => e.type === "planner.decision")?.decision).toBe("no_action");
  });
});

describe("empty wallet: insufficient funds fails honestly", () => {
  it("pays from the empty demo wallet and stops before signing — not charged", async () => {
    await resetDemo(database, "empty-wallet");
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_electricity", amountNgn: 3000, initiatedBy: "agent" });
    const pf = providerFetch({
      purchase: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader({ scheme: "exact", network: "stellar:testnet", amount: "300000", asset: TESTNET_USDC.contract, payTo: TEST_KEYS.electricity, maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } }) } }),
    });
    let balanceAsked: string | null = null;
    const r = await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl, walletBalance: async (addr) => ((balanceAsked = addr), 0n) });
    expect(balanceAsked).toBe(EMPTY.publicKey()); // the real empty wallet, not the agent wallet
    expect(r).toMatchObject({ stage: "failed", paymentStatus: "failed", failureCode: "insufficient_testnet_funds", txHash: null });
    const [pay] = await database.select().from(s.payments).where(eq(s.payments.purchaseId, p.id));
    expect(pay?.payer).toBe(EMPTY.publicKey());
    expect(pf.purchases()).toHaveLength(1);
  });

  it("the deterministic planner does not retry an empty-wallet failure with another provider", async () => {
    await resetDemo(database, "empty-wallet");
    // An honest provider: its 402 asks for exactly the quoted amount, to its registered wallet.
    const wallets: Record<string, string> = { prv_demo_electricity: TEST_KEYS.electricity, prv_demo_powergrid: TEST_KEYS.powergrid };
    const pf = providerFetch({
      purchase: (request, body) =>
        new Response("{}", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": paymentRequiredHeader({ scheme: "exact", network: "stellar:testnet", amount: String(Number(body.amountNgn) * 100), asset: TESTNET_USDC.contract, payTo: wallets[new URL(request.url).pathname.split("/")[3]!], maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } }),
          },
        }),
    });
    const { runId, done } = await startAgentRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", walletBalance: async () => 0n, buyer: { fetchImpl: pf.fetchImpl } });
    await done;
    const events = await listRunEvents(database, runId);
    expect(events.filter((e) => e.type === "planner.adapted")).toHaveLength(0);
    expect(pf.purchases()).toHaveLength(1);
    expect(events.find((e) => e.type === "payment.failed")?.error).toBe("insufficient_testnet_funds");
  });

  it("refuses clearly when the empty wallet isn't set up", async () => {
    configureTestEnv({ DEMO_EMPTY_WALLET_SECRET: "" });
    await resetDemo(database, "empty-wallet");
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_electricity", amountNgn: 3000, initiatedBy: "agent" });
    const pf = providerFetch({ purchase: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader({ scheme: "exact", network: "stellar:testnet", amount: "300000", asset: TESTNET_USDC.contract, payTo: TEST_KEYS.electricity, maxTimeoutSeconds: 300 }) } }) });
    const r = await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl, walletBalance: async () => 0n });
    expect(r).toMatchObject({ stage: "failed", failureCode: "configuration_error", paymentStatus: "failed" });
  });
});

describe("injection attempt: hostile provider text is only data", () => {
  it("the hostile description reaches the agent as labelled, untrusted provider data", async () => {
    await resetDemo(database, "injection-attempt");
    const id = await createRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "ai", model: "t", task: "t", trigger: "manual", simTime: new Date() });
    const ctx: ToolContext = { db: database, runId: id, householdId: DEMO_HOUSEHOLD_ID, quotes: new Map(), purchaseIds: [], walletBalance: async () => 100_000_000n, buyer: { fetchImpl: providerFetch().fetchImpl } };
    const r = (await callTool(ctx, "discover_providers", { utility: "airtime" })) as { note: string; providers: { provider_id: string; offer: string }[] };
    expect(r.providers.find((p) => p.provider_id === "prv_demo_topuphub")?.offer).toBe(DEMO_INJECTION_TEXT);
    expect(r.providers.find((p) => p.provider_id === "prv_demo_airtime")?.offer).not.toBe(DEMO_INJECTION_TEXT);
    expect(r.note).toMatch(/untrusted/);
  });

  it("the deterministic engine's choice is unaffected by the hostile text", async () => {
    await resetDemo(database, "injection-attempt");
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected.map((p) => p.kind)).toEqual(["airtime"]);
    expect(d.selected[0]!.product.amountNgn).toBeLessThanOrEqual(5000);
  });
});
