import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID } from "@/server/household/seed";
import { executePurchase } from "@/server/payments/x402-buyer";
import { handleProviderPurchase } from "@/server/providers/purchase-handler";
import { handleQuoteRequest, type ProviderQuote } from "@/server/providers/quote-handler";
import { DEFAULT_PROVIDER } from "@/server/providers/registry";
import { createPurchase, PolicyDeniedError, PurchaseConflictError } from "@/server/transactions/purchases";
import { TESTNET_USDC } from "@/server/payments/pricing";
import { configureTestEnv, freshDatabase, TEST_KEYS } from "./helpers";
import { paymentRequiredHeader, providerFetch } from "./provider-fetch";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const req = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://provider.test/api/providers/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const METER = { accountIdentifier: "45012345678" };
const LINE = { accountIdentifier: "+2348030000417", network: "mtn" as const };

async function quote(kind: "electricity" | "airtime" | "data", body: Record<string, unknown>): Promise<ProviderQuote> {
  const res = await handleQuoteRequest(DEFAULT_PROVIDER[kind], req(`prv_demo_${kind}/quote`, body));
  expect(res.status).toBe(200);
  return (await res.json()) as ProviderQuote;
}

describe("provider quote endpoint (free) validates before any payment", () => {
  it("issues a binding quote: price, payee, recipient, expiry", async () => {
    const q = await quote("electricity", { ...METER, amountNgn: 3000 });
    expect(q).toMatchObject({
      providerId: "prv_demo_electricity",
      amountNgn: 3000,
      recipient: { identifier: "45012345678" },
      product: { code: "elec_3000", quantity: 12.8, unit: "kWh" },
      payment: { scheme: "exact", network: "stellar:testnet", asset: TESTNET_USDC.contract, amountAtomic: "300000", amountUsdc: "0.03", payTo: TEST_KEYS.electricity },
      simulated: true,
    });
    expect(Date.parse(q.expiresAt) - Date.parse(q.issuedAt)).toBe(300_000);
  });
  it.each([
    ["malformed request", "electricity", { foo: 1 }, 400],
    ["unknown meter", "electricity", { accountIdentifier: "99999999999", amountNgn: 3000 }, 404],
    ["invalid amount", "electricity", { ...METER, amountNgn: 1234 }, 422],
    ["wrong network for the line", "airtime", { ...LINE, network: "glo", amountNgn: 500 }, 422],
  ] as const)("rejects a %s", async (_l, kind, body, status) => {
    const res = await handleQuoteRequest(DEFAULT_PROVIDER[kind], req(`prv_demo_${kind}/quote`, body));
    expect(res.status).toBe(status);
  });
  it("returns 503 when the provider is unavailable", async () => {
    await database.update(s.utilityProviders).set({ available: false }).where(eq(s.utilityProviders.kind, "electricity"));
    const res = await handleQuoteRequest(DEFAULT_PROVIDER.electricity, req("prv_demo_electricity/quote", { ...METER, amountNgn: 3000 }));
    expect(res.status).toBe(503);
  });
});

describe("purchase endpoint redeems exactly one valid quote", () => {
  const order = (q: ProviderQuote, extra: Record<string, unknown> = {}) => ({ ...METER, amountNgn: 3000, purchaseId: "pur_0000000000aaaa", quoteId: q.quoteId, ...extra });
  const purchase = (body: unknown, headers: Record<string, string> = {}) => handleProviderPurchase(DEFAULT_PROVIDER.electricity, req("prv_demo_electricity/purchase", body, headers));

  it("rejects an order without a quote", async () => {
    expect((await purchase({ ...METER, amountNgn: 3000, purchaseId: "pur_0000000000aaaa" })).status).toBe(400);
  });
  it("rejects an unknown quote", async () => {
    expect((await purchase({ ...METER, amountNgn: 3000, purchaseId: "pur_0000000000aaaa", quoteId: "qt_00000000000000zzzz" })).status).toBe(404);
  });
  it("refuses an expired quote with 410 (nothing verified, nothing charged)", async () => {
    const q = await quote("electricity", { ...METER, amountNgn: 3000 });
    await database.update(s.providerQuotes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.providerQuotes.id, q.quoteId));
    const res = await purchase(order(q));
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("quote_expired");
  });
  it("refuses a quote already redeemed by another purchase with 410", async () => {
    const q = await quote("electricity", { ...METER, amountNgn: 3000 });
    await database.update(s.providerQuotes).set({ redeemedByPurchaseId: "pur_0000000000other" }).where(eq(s.providerQuotes.id, q.quoteId));
    const res = await purchase(order(q));
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("quote_used");
  });
  it("refuses an order that doesn't match its quote", async () => {
    const q = await quote("electricity", { ...METER, amountNgn: 3000 });
    const res = await purchase(order(q, { amountNgn: 1000 }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("quote_mismatch");
  });
});

describe("provider idempotency", () => {
  const seedSettlement = async (status: "pending" | "failed") =>
    database.insert(s.providerSettlements).values({
      id: "stl_test0000000001",
      providerId: "prv_demo_electricity",
      purchaseId: "pur_0000000000bbbb",
      txHash: "f".repeat(64),
      amountAtomic: "300000",
      asset: TESTNET_USDC.contract,
      network: "stellar:testnet",
      order: { purchaseId: "pur_0000000000bbbb", accountIdentifier: "45012345678", amountNgn: 3000, kind: "electricity", accountId: DEMO_ACCOUNTS.electricity },
      fulfilmentStatus: status,
      settledAt: new Date(),
    });

  it("refuses to take a second payment for a purchase that already settled", async () => {
    await seedSettlement("failed");
    const res = await handleProviderPurchase(
      DEFAULT_PROVIDER.electricity,
      req("prv_demo_electricity/purchase", { ...METER, amountNgn: 3000, purchaseId: "pur_0000000000bbbb", quoteId: "qt_0000000000whatever" }, { "payment-signature": "anything" }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("settled_fulfilment_pending");
  });

  it("enforces one settlement per transaction hash at the database level", async () => {
    await seedSettlement("pending");
    await expect(
      database.insert(s.providerSettlements).values({
        id: "stl_test0000000002",
        providerId: "prv_demo_electricity",
        purchaseId: "pur_0000000000cccc",
        txHash: "f".repeat(64),
        amountAtomic: "300000",
        asset: TESTNET_USDC.contract,
        network: "stellar:testnet",
        order: {},
        fulfilmentStatus: "pending",
        settledAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe("purchase creation enforces authority", () => {
  const create = (o: Partial<Parameters<typeof createPurchase>[1]>) =>
    createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 3000, initiatedBy: "agent", ...o });

  it("creates a payable purchase within limits", async () => {
    expect(await create({})).toMatchObject({ stage: "requested", paymentStatus: "not_started", fulfilmentStatus: "not_started" });
  });
  it("parks purchases above the approval threshold", async () => {
    expect((await create({ amountNgn: 4500 })).stage).toBe("awaiting_approval");
  });
  it("denies purchases above the per-purchase limit without creating a row", async () => {
    await expect(create({ amountNgn: 6000 })).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(await database.select().from(s.purchases)).toHaveLength(0);
  });
  it("allows only one open purchase per utility", async () => {
    await create({ amountNgn: 1000 });
    await expect(create({ amountNgn: 1000 })).rejects.toBeInstanceOf(PurchaseConflictError);
  });
  it("returns the existing purchase for a repeated idempotency key", async () => {
    const opts = { kind: "data" as const, amountNgn: undefined, productCode: "data_750mb_7d", idempotencyKey: "dec_1:data" };
    const a = await create(opts);
    const b = await create(opts);
    expect(b.id).toBe(a.id);
  });
});

describe("buyer fails closed before signing", () => {
  const run = async (fetchOpts: Parameters<typeof providerFetch>[0]) => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 3000, initiatedBy: "agent" });
    const pf = providerFetch(fetchOpts);
    const result = await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl, horizon: async () => ({ status: "not_found" }), walletBalance: async () => 100_000_000n });
    return { result, pf, purchaseId: p.id };
  };
  const base = { scheme: "exact", network: "stellar:testnet", amount: "300000", asset: TESTNET_USDC.contract, payTo: TEST_KEYS.electricity, maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } };

  it("obtains a provider quote and binds the purchase to it", async () => {
    const { pf, purchaseId } = await run({ purchase: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader({ ...base, payTo: TEST_KEYS.airtime }) } }) });
    expect(pf.quotes()).toHaveLength(1);
    const [p] = await database.select().from(s.purchases).where(eq(s.purchases.id, purchaseId));
    expect(p!.quoteId).toMatch(/^qt_/);
    expect(p!.quoteAmountAtomic).toBe("300000");
    expect(pf.purchases()[0]!.body).toMatchObject({ quoteId: p!.quoteId });
  });

  it.each([
    ["a different recipient", { payTo: TEST_KEYS.airtime }],
    ["more than the quote (provider price changed)", { amount: "330000" }],
    ["a different asset", { asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" }],
    ["a different network", { network: "stellar:pubnet" }],
  ])("refuses a 402 asking for %s and records an honest failure", async (_label, overrides) => {
    const { result, pf } = await run({ purchase: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader({ ...base, ...overrides }) } }) });
    expect(result).toMatchObject({ stage: "failed", paymentStatus: "failed", fulfilmentStatus: "not_started", failureCode: "requirements_mismatch", txHash: null });
    expect(pf.purchases()).toHaveLength(1); // never retried with a signature
  });

  it("refuses a quote whose price changed since the decision (re-decision / re-approval needed)", async () => {
    const { result, pf } = await run({
      quote: async (request, body) => {
        const { handleQuoteRequest: h } = await import("@/server/providers/quote-handler");
        const res = await h(DEFAULT_PROVIDER.electricity, new Request(request.url, { method: "POST", body: JSON.stringify(body) }));
        const q = (await res.json()) as ProviderQuote;
        return new Response(JSON.stringify({ ...q, amountNgn: 3500, payment: { ...q.payment, amountAtomic: "350000" } }), { status: 200 });
      },
    });
    expect(result).toMatchObject({ stage: "failed", failureCode: "quote_changed" });
    expect(pf.purchases()).toHaveLength(0);
  });

  it("refuses a quote that names a payee other than the provider's registered wallet", async () => {
    const { result, pf } = await run({
      quote: async () => new Response(JSON.stringify({ quoteId: "qt_0000000000badpayee", amountNgn: 3000, expiresAt: new Date(Date.now() + 300_000).toISOString(), payment: { amountAtomic: "300000", payTo: TEST_KEYS.data } }), { status: 200 }),
    });
    expect(result).toMatchObject({ stage: "failed", failureCode: "quote_payee_mismatch" });
    expect(pf.purchases()).toHaveLength(0);
  });

  it("refuses a quote whose USDC amount doesn't match its NGN price at the demo rate", async () => {
    const { result } = await run({
      quote: async () => new Response(JSON.stringify({ quoteId: "qt_0000000000badprice", amountNgn: 3000, expiresAt: new Date(Date.now() + 300_000).toISOString(), payment: { amountAtomic: "3000000", payTo: TEST_KEYS.electricity } }), { status: 200 }),
    });
    expect(result).toMatchObject({ stage: "failed", failureCode: "quote_price_mismatch" });
  });

  it("treats a provider refusing the quote (410) as not charged", async () => {
    const { result } = await run({ purchase: () => new Response(JSON.stringify({ code: "quote_expired", message: "This quote has expired." }), { status: 410 }) });
    expect(result).toMatchObject({ stage: "failed", paymentStatus: "failed", failureCode: "quote_expired" });
  });

  it("treats an unreadable 402 as a failure, not a payment", async () => {
    const { result } = await run({ purchase: () => new Response("{}", { status: 402 }) });
    expect(result).toMatchObject({ stage: "failed", paymentStatus: "failed", failureCode: "invalid_payment_required" });
  });

  it("does not pay when the provider is unreachable", async () => {
    const { result } = await run({ quote: () => { throw new TypeError("fetch failed"); } });
    expect(result).toMatchObject({ stage: "failed", paymentStatus: "failed" });
  });

  it("re-checks authority at execution time (owner revoked auto-purchasing)", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 3000, initiatedBy: "agent" });
    await database.update(s.agentPolicies).set({ autoPurchaseEnabled: false });
    const pf = providerFetch();
    const result = await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl });
    expect(result).toMatchObject({ stage: "failed", failureCode: "policy_denied" });
    expect(pf.calls).toHaveLength(0);
  });

  it("never re-executes a purchase that has moved past requested", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 3000, initiatedBy: "agent" });
    await database.update(s.purchases).set({ stage: "submitted", paymentStatus: "submitted" }).where(eq(s.purchases.id, p.id));
    const pf = providerFetch();
    expect((await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl })).stage).toBe("submitted");
    expect(pf.calls).toHaveLength(0);
  });
});
