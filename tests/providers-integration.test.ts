/**
 * Provider integration: each provider's settlement → fulfilment path against a real
 * (temporary) database, plus facilitator outage. No testnet funds are spent here;
 * live payments are exercised by scripts/demo-providers.ts.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/config/env";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import type { UtilityKind } from "@/server/db/schema";
import { setFault } from "@/server/demo/faults";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID } from "@/server/household/seed";
import { TESTNET_USDC } from "@/server/payments/pricing";
import { executePurchase } from "@/server/payments/x402-buyer";
import { fulfilSettlement, handleFulfilmentRetry, handleProviderPurchase } from "@/server/providers/purchase-handler";
import { DEFAULT_PROVIDER, PROVIDERS } from "@/server/providers/registry";
import { createPurchase } from "@/server/transactions/purchases";
import { configureTestEnv, freshDatabase } from "./helpers";
import { providerFetch } from "./provider-fetch";

let database: Database;
let seq = 0;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const ORDERS: Record<UtilityKind, Record<string, unknown>> = {
  electricity: { accountIdentifier: "45012345678", amountNgn: 3000 },
  airtime: { accountIdentifier: "+2348030000417", network: "mtn", amountNgn: 500 },
  data: { accountIdentifier: "+2348030000417", network: "mtn", productCode: "data_1_5gb_30d" },
};

async function seedSettlement(kind: UtilityKind) {
  const purchaseId = `pur_0000000000test${seq++}`;
  const id = `stl_${purchaseId.slice(4)}`;
  await database.insert(s.providerSettlements).values({
    id,
    providerId: PROVIDERS[kind].id,
    purchaseId,
    txHash: (seq.toString(16) + "c".repeat(64)).slice(0, 64),
    amountAtomic: "1",
    asset: TESTNET_USDC.contract,
    network: "stellar:testnet",
    order: { purchaseId, ...ORDERS[kind], kind, accountId: DEMO_ACCOUNTS[kind] },
    fulfilmentStatus: "pending",
    settledAt: new Date(),
  });
  return { id, purchaseId };
}

const device = async (kind: UtilityKind) =>
  (await database.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, DEMO_ACCOUNTS[kind])))[0]!;
const simNow = async () => (await database.select().from(s.households).where(eq(s.households.id, DEMO_HOUSEHOLD_ID)))[0]!.simulatedNow;

describe.each([
  ["electricity", 8, 21.3],
  ["airtime", 200, 700],
  ["data", 150, 1686],
] as const)("%s provider fulfilment", (kind, before, after) => {
  it("credits the virtual device exactly once per settlement", async () => {
    const { id, purchaseId } = await seedSettlement(kind);
    expect((await device(kind)).balance).toBe(before);

    expect(await fulfilSettlement(id, await simNow())).toEqual({ ok: true });
    expect((await device(kind)).balance).toBe(after);

    // Second call (e.g. a retried request) must not credit again.
    expect(await fulfilSettlement(id, await simNow())).toEqual({ ok: true });
    expect((await device(kind)).balance).toBe(after);

    const fulfilments = await database.select().from(s.fulfilments).where(eq(s.fulfilments.purchaseId, purchaseId));
    expect(fulfilments).toHaveLength(1);
    expect(fulfilments[0]).toMatchObject({ balanceBefore: before, balanceAfter: after });
    const purchaseUsage = await database.select().from(s.usageRecords).where(eq(s.usageRecords.source, "purchase"));
    expect(purchaseUsage).toHaveLength(1);
  });

  it("records a failed fulfilment honestly and recovers it via the retry endpoint", async () => {
    const { id, purchaseId } = await seedSettlement(kind);
    await setFault("provider_fulfilment_failure", true);
    const failed = await fulfilSettlement(id, await simNow());
    expect(failed.ok).toBe(false);
    expect((await device(kind)).balance).toBe(before); // rolled back — nothing released
    const [stl] = await database.select().from(s.providerSettlements).where(eq(s.providerSettlements.id, id));
    expect(stl).toMatchObject({ fulfilmentStatus: "failed", fulfilmentAttempts: 1 });

    await setFault("provider_fulfilment_failure", false);
    const res = await handleFulfilmentRetry(DEFAULT_PROVIDER[kind], new Request("http://provider.test/retry", { method: "POST", body: JSON.stringify({ purchaseId }) }));
    expect(res.status).toBe(200);
    const receipt = await res.json();
    expect(receipt).toMatchObject({ simulated: true, purchaseId, payment: { status: "settled" }, fulfilment: { status: "fulfilled", balanceBefore: before, balanceAfter: after } });
    expect((await device(kind)).balance).toBe(after);
  });
});

describe("data bundle state on the device", () => {
  it("activates the bundle and sets its expiry", async () => {
    const { id } = await seedSettlement("data");
    await fulfilSettlement(id, await simNow());
    const d = await device("data");
    expect(d.activeBundle).toBe("1.5 GB · 30 days");
    expect(d.expiresAt!.getTime()).toBe((await simNow()).getTime() + 30 * 24 * 3_600_000);
  });
});

describe("retry endpoint", () => {
  it("reports no settlement (and no charge) for an unknown purchase", async () => {
    const res = await handleFulfilmentRetry(DEFAULT_PROVIDER.airtime, new Request("http://provider.test/retry", { method: "POST", body: JSON.stringify({ purchaseId: "pur_0000000000none" }) }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("no_settlement");
  });
});

describe("facilitator outage", () => {
  beforeEach(() => {
    process.env.X402_FACILITATOR_URL = "http://127.0.0.1:9";
    resetEnvCache();
  });

  it("never pays and records an honest failure when the provider cannot reach its facilitator", async () => {
    // Route the buyer's HTTP calls straight into the real provider handlers, in-process.
    const pf = providerFetch();
    const inProcessFetch = pf.fetchImpl;

    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "airtime", amountNgn: 500, initiatedBy: "agent" });
    const result = await executePurchase(database, p.id, { fetchImpl: inProcessFetch, walletBalance: async () => 100_000_000n });
    expect(pf.quotes()).toHaveLength(1); // a real quote was issued before the facilitator was needed
    expect(result).toMatchObject({ stage: "failed", paymentStatus: "failed", fulfilmentStatus: "not_started", txHash: null });
    expect((await device("airtime")).balance).toBe(200);
    const [payment] = await database.select().from(s.payments).where(eq(s.payments.purchaseId, p.id));
    expect(payment?.status).toBe("failed");
  });
});
