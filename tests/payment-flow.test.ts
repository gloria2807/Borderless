import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID } from "@/server/household/seed";
import { executePurchase } from "@/server/payments/x402-buyer";
import { handleProviderPurchase } from "@/server/providers/purchase-handler";
import { createPurchase, PolicyDeniedError, PurchaseConflictError } from "@/server/transactions/purchases";
import { TESTNET_USDC } from "@/server/payments/pricing";
import { configureTestEnv, freshDatabase, TEST_KEYS } from "./helpers";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const providerRequest = (kind: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://provider.test/api/providers/${kind}/purchase`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("provider endpoint validates before asking for payment", () => {
  it("rejects malformed orders with 400", async () => {
    const res = await handleProviderPurchase("electricity", providerRequest("electricity", { purchaseId: "nope" }));
    expect(res.status).toBe(400);
  });
  it("rejects unknown meters with 404", async () => {
    const res = await handleProviderPurchase(
      "electricity",
      providerRequest("electricity", { purchaseId: "pur_0000000000aaaa", accountIdentifier: "99999999999", amountNgn: 3000 }),
    );
    expect(res.status).toBe(404);
  });
  it("rejects invalid amounts with 422", async () => {
    const res = await handleProviderPurchase(
      "electricity",
      providerRequest("electricity", { purchaseId: "pur_0000000000aaaa", accountIdentifier: "45012345678", amountNgn: 1234 }),
    );
    expect(res.status).toBe(422);
  });
  it("rejects a network that does not match the recipient line", async () => {
    const res = await handleProviderPurchase(
      "airtime",
      providerRequest("airtime", { purchaseId: "pur_0000000000aaaa", accountIdentifier: "+2348030000417", network: "glo", amountNgn: 500 }),
    );
    expect(res.status).toBe(422);
  });
  it("returns 503 when the provider is marked unavailable", async () => {
    await database.update(s.utilityProviders).set({ available: false }).where(eq(s.utilityProviders.kind, "electricity"));
    const res = await handleProviderPurchase(
      "electricity",
      providerRequest("electricity", { purchaseId: "pur_0000000000aaaa", accountIdentifier: "45012345678", amountNgn: 3000 }),
    );
    expect(res.status).toBe(503);
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
      "electricity",
      providerRequest(
        "electricity",
        { purchaseId: "pur_0000000000bbbb", accountIdentifier: "45012345678", amountNgn: 3000 },
        { "payment-signature": "anything" },
      ),
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
  const paymentRequiredHeader = (overrides: Record<string, unknown>) =>
    Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: { url: "http://provider.test/api/providers/electricity/purchase" },
        accepts: [
          {
            scheme: "exact",
            network: "stellar:testnet",
            amount: "300000",
            asset: TESTNET_USDC.contract,
            payTo: TEST_KEYS.electricity,
            maxTimeoutSeconds: 300,
            extra: { areFeesSponsored: true },
            ...overrides,
          },
        ],
      }),
    ).toString("base64");

  const run = async (respond: () => Response | Promise<Response>) => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 3000, initiatedBy: "agent" });
    const fetchMock = vi.fn(async () => respond());
    const result = await executePurchase(database, p.id, { fetchImpl: fetchMock as unknown as typeof fetch, horizon: vi.fn() });
    return { result, fetchMock };
  };

  it.each([
    ["a different recipient", { payTo: TEST_KEYS.airtime }],
    ["a higher amount", { amount: "3000000" }],
    ["a different asset", { asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" }],
    ["a different network", { network: "stellar:pubnet" }],
  ])("refuses requirements with %s and records an honest failure", async (_label, overrides) => {
    const { result, fetchMock } = await run(
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader(overrides) } }),
    );
    expect(result).toMatchObject({
      stage: "failed",
      paymentStatus: "failed",
      fulfilmentStatus: "not_started",
      failureCode: "requirements_mismatch",
      txHash: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried with a signature
  });

  it("treats an unreadable 402 as a failure, not a payment", async () => {
    const { result } = await run(() => new Response("{}", { status: 402 }));
    expect(result).toMatchObject({ stage: "failed", paymentStatus: "failed", failureCode: "invalid_payment_required" });
  });

  it("does not pay when the provider is unreachable", async () => {
    const { result } = await run(() => {
      throw new TypeError("fetch failed");
    });
    expect(result).toMatchObject({ stage: "failed", paymentStatus: "failed", failureCode: "provider_unreachable" });
  });

  it("re-checks authority at execution time (owner revoked auto-purchasing)", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 3000, initiatedBy: "agent" });
    await database.update(s.agentPolicies).set({ autoPurchaseEnabled: false });
    const fetchMock = vi.fn();
    const result = await executePurchase(database, p.id, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(result).toMatchObject({ stage: "failed", failureCode: "policy_denied" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never re-executes a purchase that has moved past requested", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 3000, initiatedBy: "agent" });
    await database.update(s.purchases).set({ stage: "submitted", paymentStatus: "submitted" }).where(eq(s.purchases.id, p.id));
    const fetchMock = vi.fn();
    expect((await executePurchase(database, p.id, { fetchImpl: fetchMock as unknown as typeof fetch })).stage).toBe("submitted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
