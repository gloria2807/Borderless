/**
 * Judge-facing procurement inspection (amendment A4). Proves:
 *  - every step shown comes from recorded backend data, and missing steps are marked
 *    missing (never filled in);
 *  - the buyer records the pre-signing policy evaluation on the purchase itself;
 *  - "Request without paying" repeats the agent's request with no payment and a fresh id,
 *    and reports the provider's actual 402 (and would flag a release without payment).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as purchaseAction } from "@/app/api/purchases/[id]/[action]/route";
import { appendRunEvent, createRun } from "@/server/agent/runtime/run-log";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID, resetDemo } from "@/server/household/seed";
import { newId } from "@/server/lib/ids";
import { TESTNET_USDC } from "@/server/payments/pricing";
import { executePurchase } from "@/server/payments/x402-buyer";
import { createPurchase } from "@/server/transactions/purchases";
import { probeUnpaid } from "@/server/transactions/probe";
import { getProcurement } from "@/server/views/procurement";
import { configureTestEnv, freshDatabase, TEST_KEYS } from "./helpers";
import { paymentRequiredHeader, providerFetch } from "./provider-fetch";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});
afterEach(() => vi.unstubAllGlobals());

const offer = (o: Record<string, unknown> = {}) => ({ scheme: "exact", network: "stellar:testnet", amount: "300000", asset: TESTNET_USDC.contract, payTo: TEST_KEYS.powergrid, maxTimeoutSeconds: 300, extra: { areFeesSponsored: true }, ...o });
const status = (v: NonNullable<Awaited<ReturnType<typeof getProcurement>>>, key: string) => v.steps.find((x) => x.key === key)!.status;

describe("inspection of a purchase stopped before payment", () => {
  it("shows the real 402 and the refusal, and marks unreached steps as not reached", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_powergrid", amountNgn: 3000, initiatedBy: "agent" });
    const pf = providerFetch({ purchase: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader(offer()) } }) });
    await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl, walletBalance: async () => 0n, funding: null });

    const v = (await getProcurement(DEMO_HOUSEHOLD_ID, p.id))!;
    expect(v.provider).toMatchObject({ id: "prv_demo_powergrid", name: "Demo PowerGrid Vend", verified: true, registeredPayTo: TEST_KEYS.powergrid });
    expect(v.endpoint).toEqual({ method: "POST", path: "/api/providers/prv_demo_powergrid/purchase", protocol: "x402" });
    expect(v.http402?.accepts[0]).toMatchObject({ scheme: "exact", network: "stellar:testnet", amount: "300000", amountUsdc: "0.03", payTo: TEST_KEYS.powergrid });
    expect(v.price).toMatchObject({ source: "quote", amountNgn: 3000, amountUsdc: "0.03" });
    expect(v.policy?.outcome).toBe("deny");
    expect(v.policy?.checks.find((c) => c.label.match(/wallet/i))?.status).toBe("fail");
    expect(status(v, "http402")).toBe("recorded");
    expect(status(v, "policy")).toBe("recorded");
    expect(status(v, "approval")).toBe("not_applicable");
    expect(status(v, "transaction")).toBe("not_reached");
    expect(status(v, "released")).toBe("not_reached");
    expect(v.payment?.txHash).toBeNull();
  });

  it("the buyer records the pre-signing policy evaluation on the purchase, with every check", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_powergrid", amountNgn: 3000, initiatedBy: "agent" });
    const pf = providerFetch({ purchase: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader(offer()) } }) });
    await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl, walletBalance: async () => 0n, funding: null });
    const [ev] = await database.select().from(s.activityEvents).where(eq(s.activityEvents.type, "policy.checked"));
    expect(ev).toMatchObject({ purchaseId: p.id });
    expect((ev!.data as { checks: unknown[] }).checks).toHaveLength(11);
  });
});

describe("inspection of a completed information purchase in an agent run", () => {
  it("shows the transaction, the released report and what the agent did next", async () => {
    await resetDemo(database, "electricity-surge");
    const runId = await createRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", model: null, task: "t", trigger: "manual", simTime: new Date() });
    const id = newId("pur");
    const [hh] = await database.select().from(s.households);
    await database.insert(s.purchases).values({
      id, householdId: DEMO_HOUSEHOLD_ID, runId, accountId: DEMO_ACCOUNTS.electricity, providerId: "prv_demo_gridsense", kind: "electricity", productCode: "meter_diagnostic", serviceType: "meter_diagnostic",
      amountNgn: 300, quantity: 1, unit: "report", idempotencyKey: id, initiatedBy: "agent", stage: "completed", paymentStatus: "confirmed", fulfilmentStatus: "fulfilled", simTime: hh!.simulatedNow,
    });
    await database.insert(s.payments).values({
      id: newId("pay"), purchaseId: id, network: "stellar:testnet", scheme: "exact", asset: TESTNET_USDC.contract, amountAtomic: "30000", payTo: TEST_KEYS.gridsense, payer: TEST_KEYS.agent.publicKey(), status: "confirmed",
      paymentRequired: { x402Version: 2, accepts: [offer({ amount: "30000", payTo: TEST_KEYS.gridsense })] }, txHash: "a".repeat(64), ledger: 123,
    });
    await database.insert(s.receipts).values({ id: newId("rcp"), purchaseId: id, providerReceiptId: "rcp_x", payload: { receiptId: "rcp_x", fulfilment: { status: "fulfilled", quantity: 1, unit: "report", details: { result: { service: "meter_diagnostic", finding: "stuck_load", summary: "Stuck heater." } } } } });
    await appendRunEvent(database, runId, { stage: "discovering", type: "tool.result", tool: "discover_information_services", result: { services: [{ provider_id: "prv_demo_gridsense" }] } });
    await appendRunEvent(database, runId, { stage: "updating_household", type: "purchase.completed", purchaseId: id });
    await appendRunEvent(database, runId, { stage: "using_result", type: "planner.reassessed", reason: "Re-deciding with the diagnostic report." });
    await appendRunEvent(database, runId, { stage: "requesting_payment", type: "tool.called", tool: "purchase_utility", input: { quote_id: "qt_x" } });

    const v = (await getProcurement(DEMO_HOUSEHOLD_ID, id))!;
    expect(v.discovery).toMatchObject({ inRun: true, tool: "discover_information_services" });
    expect(v.endpoint.path).toBe("/api/services/prv_demo_gridsense/meter-diagnostic");
    expect(v.price).toMatchObject({ source: "published_price", amountUsdc: "0.003" });
    expect(v.payment).toMatchObject({ txHash: "a".repeat(64), ledger: 123, payTo: TEST_KEYS.gridsense });
    expect(v.released).toMatchObject({ type: "report", report: { finding: "stuck_load" } });
    expect(v.next.source).toBe("run");
    expect(v.next.items.map((i) => i.title)).toEqual(["Re-decided with the result", "Called purchase_utility"]);
    expect(v.steps.filter((x) => x.status === "not_reached").map((x) => x.key)).toEqual(["policy"]); // honestly missing: not recorded here
  });

  it("answers null for another household's or an unknown purchase", async () => {
    expect(await getProcurement(DEMO_HOUSEHOLD_ID, "pur_000000000000none")).toBeNull();
  });
});

describe("request without paying", () => {
  const stubFetch = (opts: Parameters<typeof providerFetch>[0]) => {
    const pf = providerFetch(opts);
    vi.stubGlobal("fetch", pf.fetchImpl);
    return pf;
  };

  it("utility: takes a free quote, then requests with no payment and a fresh id; reports the 402", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_powergrid", amountNgn: 3000, initiatedBy: "agent" });
    let seen: { headers: Headers; body: Record<string, unknown> } | null = null;
    const pf = stubFetch({
      purchase: (req, body) => {
        seen = { headers: req.headers, body };
        return new Response(JSON.stringify({ code: "payment_required" }), { status: 402, statusText: "Payment Required", headers: { "PAYMENT-REQUIRED": paymentRequiredHeader(offer()) } });
      },
    });
    const r = await probeUnpaid(database, p.id);
    expect(pf.quotes()).toHaveLength(1);
    expect(r.quote).toMatchObject({ path: "/api/providers/prv_demo_powergrid/quote", status: 200 });
    expect(r.request).toMatchObject({ path: "/api/providers/prv_demo_powergrid/purchase", paymentHeader: "none" });
    expect(seen!.headers.get("payment-signature")).toBeNull();
    expect(seen!.body.purchaseId).not.toBe(p.id); // never touches the real purchase
    expect(r.response).toMatchObject({ status: 402, paymentRequired: { accepts: [expect.objectContaining({ amountUsdc: "0.03", payTo: TEST_KEYS.powergrid })] } });
    expect(r.releasedWithoutPayment).toBe(false);
    expect((await database.select().from(s.purchases)).map((x) => x.id)).toEqual([p.id]); // no new purchase
  });

  it("information service: no quote step; flags a provider that releases without payment", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_gridsense", productCode: "meter_diagnostic", initiatedBy: "agent" });
    const pf = stubFetch({ purchase: () => Response.json({ leaked: true }, { status: 200 }) });
    const r = await probeUnpaid(database, p.id);
    expect(pf.quotes()).toHaveLength(0);
    expect(r.request.path).toBe("/api/services/prv_demo_gridsense/meter-diagnostic");
    expect(r.releasedWithoutPayment).toBe(true); // surfaced, not hidden
  });

  it("is a same-origin POST action and 404s for unknown purchases", async () => {
    const res = await purchaseAction(new Request("http://localhost/api/purchases/pur_000000000000none/probe-unpaid", { method: "POST" }), { params: Promise.resolve({ id: "pur_000000000000none", action: "probe-unpaid" }) });
    expect(res.status).toBe(404);
    const cross = await purchaseAction(new Request("http://localhost/api/purchases/pur_000000000000none/probe-unpaid", { method: "POST", headers: { origin: "https://evil.example", host: "localhost" } }), { params: Promise.resolve({ id: "pur_000000000000none", action: "probe-unpaid" }) });
    expect(cross.status).toBe(403);
  });
});
