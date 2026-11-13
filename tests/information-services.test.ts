/**
 * Paid information services (procurement amendment A2). Proves:
 *  - meter diagnostics are registered intelligence providers, separate from the utility
 *    catalogue, publishing an x402-protected endpoint with no quote step;
 *  - the report is released only through a settled payment, never touches a device, and a
 *    repeat request returns the stored result without a new charge;
 *  - the report reflects provider-side ground truth the agent cannot read for free;
 *  - the buyer pays exactly the published price to the registered wallet, and the policy
 *    engine applies a separate cap to information purchases;
 *  - agent tools can discover and buy information, and refuse unregistered or unverified providers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as serviceRoute } from "@/app/api/services/[providerId]/[service]/route";
import { createRun } from "@/server/agent/runtime/run-log";
import { callTool, type ToolContext } from "@/server/agent/runtime/tools";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import type { MeterProfile } from "@/server/db/schema";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID, resetDemo } from "@/server/household/seed";
import { TESTNET_USDC } from "@/server/payments/pricing";
import { executePurchase } from "@/server/payments/x402-buyer";
import { serviceDocument, verifyServiceDocument } from "@/server/providers/catalog";
import { fulfilSettlement, handleFulfilmentRetry } from "@/server/providers/purchase-handler";
import { intelligenceProvidersFor, providersFor, requireProvider } from "@/server/providers/registry";
import { createPurchase, PolicyDeniedError } from "@/server/transactions/purchases";
import { configureTestEnv, freshDatabase, TEST_KEYS } from "./helpers";
import { paymentRequiredHeader, providerFetch } from "./provider-fetch";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const METER = "45012345678";
const meter = async () => (await database.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, DEMO_ACCOUNTS.electricity)))[0]!;
const simNow = async () => (await database.select().from(s.households).where(eq(s.households.id, DEMO_HOUSEHOLD_ID)))[0]!.simulatedNow;
const callService = (providerId: string, slug: string, body: unknown, headers: Record<string, string> = {}) =>
  serviceRoute(new Request(`http://localhost/api/services/${providerId}/${slug}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ providerId, service: slug }),
  });

let seq = 0;
/** A settlement as the provider records it after a facilitator-confirmed payment. */
async function settledDiagnostic(providerId = "prv_demo_gridsense") {
  const purchaseId = `pur_0000000000diag${seq++}`;
  const id = `stl_${purchaseId.slice(4)}`;
  await database.insert(s.providerSettlements).values({
    id,
    providerId,
    purchaseId,
    txHash: (seq.toString(16) + "d".repeat(64)).slice(0, 64),
    amountAtomic: "30000",
    asset: TESTNET_USDC.contract,
    network: "stellar:testnet",
    order: { purchaseId, accountIdentifier: METER, productCode: "meter_diagnostic", kind: "electricity", accountId: DEMO_ACCOUNTS.electricity },
    fulfilmentStatus: "pending",
    settledAt: new Date(),
  });
  return { id, purchaseId };
}

async function reportFor(profile: MeterProfile | null, providerId = "prv_demo_meterlab") {
  await resetDemo(database, "electricity-surge");
  await database.delete(s.meterProfiles);
  if (profile) await database.insert(s.meterProfiles).values({ accountId: DEMO_ACCOUNTS.electricity, profile, magnitude: 0.68, since: new Date() });
  const { id } = await settledDiagnostic(providerId);
  expect(await fulfilSettlement(id, await simNow())).toEqual({ ok: true });
  const [ful] = await database.select().from(s.fulfilments).where(eq(s.fulfilments.settlementId, id));
  return (ful!.details as { result: Record<string, unknown> }).result;
}

describe("registry and published documents", () => {
  it("diagnostics are intelligence providers, kept out of the utility catalogue", () => {
    expect(intelligenceProvidersFor("electricity").map((m) => m.definition.id)).toEqual(["prv_demo_gridsense", "prv_demo_meterlab"]);
    expect(providersFor("electricity").map((m) => m.definition.id)).toEqual(["prv_demo_electricity", "prv_demo_powergrid"]);
  });

  it("publish a paid x402 endpoint with no quote step, and verify against the registry", async () => {
    const doc = await serviceDocument(database, requireProvider("prv_demo_gridsense"));
    expect(doc).toMatchObject({ category: "intelligence", payment: { protocol: "x402", payTo: TEST_KEYS.gridsense } });
    expect(doc.products).toEqual([expect.objectContaining({ code: "meter_diagnostic", priceNgn: 300, unit: "report" })]);
    expect(doc.endpoints.map((e) => [e.name, e.path, e.paid])).toEqual([
      ["service", "/api/providers/prv_demo_gridsense/service", false],
      ["meter-diagnostic", "/api/services/prv_demo_gridsense/meter-diagnostic", true],
    ]);
    expect(verifyServiceDocument("prv_demo_gridsense", doc).verified).toBe(true);
  });
});

describe("the paid endpoint validates before any payment", () => {
  it.each([
    ["malformed order", "prv_demo_gridsense", "meter-diagnostic", { foo: 1 }, 400],
    ["unknown meter", "prv_demo_gridsense", "meter-diagnostic", { accountIdentifier: "99999999999", purchaseId: "pur_0000000000aaaa" }, 404],
    ["unknown service", "prv_demo_gridsense", "outage-forecast", { accountIdentifier: METER, purchaseId: "pur_0000000000aaaa" }, 404],
    ["utility provider on the service route", "prv_demo_electricity", "meter-diagnostic", { accountIdentifier: METER, purchaseId: "pur_0000000000aaaa" }, 404],
  ])("rejects a %s", async (_l, providerId, slug, body, status) => {
    expect((await callService(providerId, slug, body)).status).toBe(status);
  });

  it("answers 503 while the provider is down", async () => {
    await database.update(s.utilityProviders).set({ available: false }).where(eq(s.utilityProviders.id, "prv_demo_gridsense"));
    expect((await callService("prv_demo_gridsense", "meter-diagnostic", { accountIdentifier: METER, purchaseId: "pur_0000000000aaaa" })).status).toBe(503);
  });
});

describe("the report is released only after settlement, and never touches the meter", () => {
  it("releases a report for a settled payment; the meter balance is unchanged", async () => {
    const before = await meter();
    const { id, purchaseId } = await settledDiagnostic();
    expect(await fulfilSettlement(id, await simNow())).toEqual({ ok: true });
    expect((await meter()).balance).toBe(before.balance);
    const [ful] = await database.select().from(s.fulfilments).where(eq(s.fulfilments.settlementId, id));
    expect(ful).toMatchObject({ quantity: 1, unit: "report", demoToken: null, balanceBefore: before.balance, balanceAfter: before.balance });
    // A repeat request for the same paid purchase returns the stored receipt, not a 402 or a new charge.
    const replay = await callService("prv_demo_gridsense", "meter-diagnostic", { accountIdentifier: METER, purchaseId });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-borderless-replay")).toBe("true");
    expect(((await replay.json()) as { fulfilment: { details: { result: { service: string } } } }).fulfilment.details.result.service).toBe("meter_diagnostic");
  });

  it("the no-repay retry endpoint re-releases a failed delivery", async () => {
    const { purchaseId } = await settledDiagnostic();
    const res = await handleFulfilmentRetry(requireProvider("prv_demo_gridsense"), new Request("http://x/retry", { method: "POST", body: JSON.stringify({ purchaseId }) }));
    expect(res.status).toBe(200);
  });
});

describe("the report reflects what the agent cannot see for free", () => {
  it.each([
    ["stuck_water_heater", "stuck_load", /water heater/i, true],
    ["extra_occupancy", "extra_occupancy", /more people/i, false],
    ["meter_overreading", "meter_overreading", /over-reading/i, true],
    [null, "normal", /No fault/i, false],
  ] as const)("profile %s → finding %s", async (profile, finding, summary, avoidable) => {
    const r = await reportFor(profile);
    expect(r).toMatchObject({ service: "meter_diagnostic", finding, simulated: true });
    expect(String(r.summary)).toMatch(summary);
    expect(Number(r.avoidableKwhPerDay) > 0).toBe(avoidable);
    expect(Number(r.observedKwhPerHour)).toBeGreaterThan(0.8); // the surge is real in the meter readings
  });

  it("the basic report gives the finding; the detailed one adds circuit-level evidence", async () => {
    const basic = await reportFor("stuck_water_heater", "prv_demo_gridsense");
    const detailed = await reportFor("stuck_water_heater", "prv_demo_meterlab");
    expect(basic.circuits).toBeUndefined();
    expect(basic).toMatchObject({ confidence: "medium", finding: "stuck_load" });
    expect(detailed).toMatchObject({ confidence: "high", finding: "stuck_load" });
    const heater = (detailed.circuits as { circuit: string; observedKw: number; normalKw: number }[]).find((c) => c.circuit === "Water heater")!;
    expect(heater.observedKw).toBeGreaterThan(heater.normalKw * 5);
  });

  it("no agent tool, planner or view reads the provider-side ground truth", () => {
    const roots = ["src/server/agent", "src/server/views", "src/app", "src/components"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && /meterProfiles|meter_profiles/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});

describe("buying information: buyer and spending rules", () => {
  it("records an information purchase and counts it against the household budget", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_gridsense", productCode: "meter_diagnostic", initiatedBy: "agent" });
    expect(p).toMatchObject({ serviceType: "meter_diagnostic", amountNgn: 300, quantity: 1, unit: "report", stage: "requested" });
  });

  it("information purchases have their own cap", async () => {
    await database.update(s.agentPolicies).set({ intelligenceCapNgn: 500 });
    await expect(createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_meterlab", productCode: "meter_diagnostic", initiatedBy: "agent" })).rejects.toMatchObject({
      violations: [expect.objectContaining({ code: "exceeds_intelligence_cap" })],
    });
    await expect(createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_gridsense", productCode: "meter_diagnostic", initiatedBy: "agent" })).resolves.toBeTruthy();
  });

  it("the buyer requests no quote and expects a 402 for exactly the published price to the registered wallet", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_gridsense", productCode: "meter_diagnostic", initiatedBy: "agent" });
    const offer = { scheme: "exact", network: "stellar:testnet", amount: "30000", asset: TESTNET_USDC.contract, payTo: TEST_KEYS.gridsense, maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } };
    const pf = providerFetch({ purchase: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader(offer) } }) });
    const r = await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl, walletBalance: async () => 0n, funding: null });
    expect(pf.quotes()).toHaveLength(0);
    expect(pf.purchases().map((c) => c.url)).toEqual(["/api/services/prv_demo_gridsense/meter-diagnostic"]);
    expect(pf.purchases()[0]!.body).toEqual({ accountIdentifier: METER, purchaseId: p.id, productCode: "meter_diagnostic" });
    expect(r.failureCode).toBe("insufficient_testnet_funds"); // reached the pre-sign check with the right expectations
  });

  it.each([
    ["a higher price", { amount: "60000" }],
    ["another payee", { payTo: TEST_KEYS.meterlab }],
  ])("refuses a 402 asking for %s", async (_l, override) => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_gridsense", productCode: "meter_diagnostic", initiatedBy: "agent" });
    const offer = { scheme: "exact", network: "stellar:testnet", amount: "30000", asset: TESTNET_USDC.contract, payTo: TEST_KEYS.gridsense, maxTimeoutSeconds: 300, ...override };
    const pf = providerFetch({ purchase: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader(offer) } }) });
    const r = await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl, walletBalance: async () => 100_000_000n, funding: null });
    expect(r).toMatchObject({ stage: "failed", paymentStatus: "failed", failureCode: "requirements_mismatch", txHash: null });
  });
});

describe("agent tools for information", () => {
  async function ctx(opts: Parameters<typeof providerFetch>[0] = {}) {
    const runId = await createRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "ai", model: "t", task: "t", trigger: "manual", simTime: new Date() });
    const pf = providerFetch(opts);
    const c: ToolContext = { db: database, runId, householdId: DEMO_HOUSEHOLD_ID, quotes: new Map(), purchaseIds: [], walletBalance: async () => 0n, buyer: { fetchImpl: pf.fetchImpl } };
    return { c, pf };
  }

  it("discovers both diagnostic services over HTTP with prices and paid endpoints", async () => {
    const { c, pf } = await ctx();
    const r = (await callTool(c, "discover_information_services", { utility: "electricity" })) as { services: { provider_id: string; price_ngn: number; verified: boolean; paid_endpoint: { path: string } }[] };
    expect(r.services.map((x) => [x.provider_id, x.price_ngn, x.verified])).toEqual([["prv_demo_gridsense", 300, true], ["prv_demo_meterlab", 800, true]]);
    expect(r.services[0]!.paid_endpoint.path).toBe("/api/services/prv_demo_gridsense/meter-diagnostic");
    expect(pf.calls.every((x) => x.kind === "discovery")).toBe(true);
  });

  it("refuses to buy from a utility provider or an unknown one", async () => {
    const { c } = await ctx();
    expect(await callTool(c, "buy_information", { provider_id: "prv_demo_electricity", reason: "check the meter" })).toMatchObject({ status: "refused" });
    expect(await callTool(c, "buy_information", { provider_id: "prv_attacker", reason: "check the meter" })).toMatchObject({ status: "refused" });
    expect(await database.select().from(s.purchases)).toHaveLength(0);
  });

  it("refuses a provider whose published document failed verification", async () => {
    const { c } = await ctx({ service: (id, d) => (id === "prv_demo_gridsense" ? { ...d, payment: { ...(d.payment as object), payTo: TEST_KEYS.agent.publicKey() } } : d) });
    await callTool(c, "discover_information_services", { utility: "electricity" });
    expect(await callTool(c, "buy_information", { provider_id: "prv_demo_gridsense", reason: "check the meter" })).toMatchObject({ status: "refused", reason: expect.stringMatching(/failed verification/) });
  });

  it("goes through the x402 path and reports honestly when the wallet can't pay", async () => {
    await resetDemo(database, "electricity-surge");
    const offer = { scheme: "exact", network: "stellar:testnet", amount: "30000", asset: TESTNET_USDC.contract, payTo: TEST_KEYS.gridsense, maxTimeoutSeconds: 300 };
    const { c } = await ctx({ purchase: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader(offer) } }) });
    const r = (await callTool(c, "buy_information", { provider_id: "prv_demo_gridsense", reason: "Find out why electricity use tripled before buying more." })) as { status: string; report: unknown };
    expect(r).toMatchObject({ status: "failed", report: null });
    const [p] = await database.select().from(s.purchases);
    expect(p).toMatchObject({ serviceType: "meter_diagnostic", paymentStatus: "failed", failureCode: "insufficient_testnet_funds" });
  });
});
