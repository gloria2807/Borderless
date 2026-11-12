/**
 * x402-protected provider purchase endpoint.
 *
 * Ordering guarantee (the reason we do not use `withX402`, which runs the handler
 * BEFORE settling):
 *
 *   validate order → 402 | verify (facilitator) → settle (facilitator, on-chain)
 *   → record settlement (unique tx hash) → release simulated utility → receipt
 *
 * No code path credits a virtual device unless `processSettlement` returned success
 * with a transaction hash.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import type { HTTPResponseInstructions } from "@x402/core/server";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { newId } from "../lib/ids";
import { isFaultEnabled } from "../demo/faults";
import { PROVIDERS, ProductError, resolveProduct } from "./catalog";
import { applyFulfilment } from "./fulfilment";
import { fulfilmentRetrySchema, providerOrderSchema, type ProviderOrder } from "./order";
import { createRequestContext } from "./http-adapter";
import { getSeller } from "./x402-seller";
import type { ProviderReceipt } from "./receipt";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store, private", ...headers },
  });

const fromInstructions = (r: HTTPResponseInstructions) =>
  new Response(r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json", ...r.headers, "cache-control": "no-store, private" },
  });

/** In-process guard so two concurrent requests for one purchase can never both settle. */
const globalLocks = globalThis as unknown as { __borderlessProviderLocks?: Set<string> };
const inFlight = (globalLocks.__borderlessProviderLocks ??= new Set());

export async function handleProviderPurchase(kind: UtilityKind, request: Request): Promise<Response> {
  const provider = PROVIDERS[kind];

  // 1. Validate the order.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(400, { code: "invalid_json", message: "Request body must be JSON." });
  }
  const parsed = providerOrderSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { code: "invalid_order", message: parsed.error.issues.map((i) => i.message).join("; ") });
  }
  const order = parsed.data;

  const database = db();
  const [providerRow] = await database.select().from(s.utilityProviders).where(eq(s.utilityProviders.id, provider.id));
  if (!providerRow?.available) {
    return json(503, { code: "provider_unavailable", message: `${provider.name} is currently unavailable (demo).` });
  }

  const [account] = await database
    .select()
    .from(s.utilityAccounts)
    .where(and(eq(s.utilityAccounts.kind, kind), eq(s.utilityAccounts.identifier, order.accountIdentifier)));
  if (!account) {
    return json(404, { code: "unknown_account", message: `No ${kind} account matches that identifier.` });
  }
  if (kind !== "electricity") {
    if (!order.network || order.network !== account.network) {
      return json(422, { code: "network_mismatch", message: "The network does not match the recipient line." });
    }
    if (!provider.networks.includes(order.network)) {
      return json(422, { code: "unsupported_network", message: `${provider.name} does not serve that network.` });
    }
  }

  let product;
  try {
    product = resolveProduct(kind, order);
  } catch (err) {
    if (err instanceof ProductError) return json(422, { code: err.code, message: err.message });
    throw err;
  }

  // 2. Idempotency: a purchase that already settled is never charged again.
  const existing = await findSettlement(provider.id, order.purchaseId);
  if (existing) {
    if (existing.fulfilmentStatus === "fulfilled") {
      const receipt = await buildReceipt(existing.id);
      return json(200, receipt, { "x-borderless-replay": "true" });
    }
    return json(409, {
      code: "settled_fulfilment_pending",
      message: "This purchase is already paid. Use the fulfilment retry endpoint — do not pay again.",
      txHash: existing.txHash,
    });
  }

  const lockKey = `${provider.id}:${order.purchaseId}`;
  if (context402Only(request)) {
    // Unpaid request: just return the 402 challenge (no lock needed).
    return challengeOrError(kind, request, order);
  }
  if (inFlight.has(lockKey)) {
    return json(409, { code: "purchase_in_progress", message: "A payment for this purchase is already being processed." });
  }
  inFlight.add(lockKey);
  try {
    return await settleAndFulfil(kind, request, order, product, account.id);
  } finally {
    inFlight.delete(lockKey);
  }
}

function context402Only(request: Request): boolean {
  return !request.headers.get("payment-signature") && !request.headers.get("x-payment");
}

async function challengeOrError(kind: UtilityKind, request: Request, order: ProviderOrder): Promise<Response> {
  const seller = await getSeller(kind);
  const result = await seller.processHTTPRequest(createRequestContext(request, order));
  if (result.type === "payment-error") return fromInstructions(result.response);
  // Any other result for an unpaid request would mean the route is misconfigured. Fail closed.
  return json(500, { code: "x402_misconfigured", message: "Payment protection is not active for this route." });
}

async function settleAndFulfil(
  kind: UtilityKind,
  request: Request,
  order: ProviderOrder,
  product: ReturnType<typeof resolveProduct>,
  accountId: string,
): Promise<Response> {
  const provider = PROVIDERS[kind];
  const seller = await getSeller(kind);
  const context = createRequestContext(request, order);

  // 3. Verify with the facilitator.
  const verified = await seller.processHTTPRequest(context);
  if (verified.type === "payment-error") return fromInstructions(verified.response);
  if (verified.type !== "payment-verified") {
    return json(500, { code: "x402_misconfigured", message: "Payment protection is not active for this route." });
  }

  // 4. Settle on Stellar testnet via the facilitator. Nothing has been released yet.
  const settled = await seller.processSettlement(
    verified.paymentPayload,
    verified.paymentRequirements,
    verified.declaredExtensions,
    { request: context },
  );
  if (!settled.success || !settled.transaction) {
    if (settled.success) {
      return json(502, { code: "settlement_missing_tx", message: "Facilitator reported success without a transaction hash." });
    }
    return fromInstructions(settled.response);
  }

  // 5. Record the settlement (provider ledger). Unique tx hash ⇒ one fulfilment per payment.
  const database = db();
  const [household] = await database
    .select({ simNow: s.households.simulatedNow })
    .from(s.households)
    .innerJoin(s.utilityAccounts, eq(s.utilityAccounts.householdId, s.households.id))
    .where(eq(s.utilityAccounts.id, accountId));
  const simNow = household?.simNow ?? new Date();
  const settlementId = newId("stl");
  await database.insert(s.providerSettlements).values({
    id: settlementId,
    providerId: provider.id,
    purchaseId: order.purchaseId,
    txHash: settled.transaction,
    payer: settled.payer ?? null,
    amountAtomic: settled.requirements.amount,
    asset: settled.requirements.asset,
    network: settled.network,
    order: { ...order, kind, accountId, productCode: product.code },
    fulfilmentStatus: "pending",
    settledAt: new Date(),
  });

  // 6. Release the simulated utility.
  const fulfilled = await fulfilSettlement(settlementId, simNow);
  const paymentHeaders = settled.headers;
  if (!fulfilled.ok) {
    return json(
      502,
      {
        code: "fulfilment_failed",
        message: "Payment settled on Stellar testnet, but the provider could not release the utility. It can be retried without paying again.",
        txHash: settled.transaction,
        reason: fulfilled.error,
      },
      paymentHeaders,
    );
  }
  return json(200, await buildReceipt(settlementId), paymentHeaders);
}

/**
 * Release (or re-release) the utility for a settlement. Safe to call repeatedly:
 * a settlement that is already fulfilled is never fulfilled twice.
 */
export async function fulfilSettlement(settlementId: string, simNow: Date): Promise<{ ok: true } | { ok: false; error: string }> {
  const database = db();
  // Count the attempt outside the transaction so it survives a rollback.
  await database
    .update(s.providerSettlements)
    .set({ fulfilmentAttempts: sql`${s.providerSettlements.fulfilmentAttempts} + 1`, updatedAt: new Date() })
    .where(eq(s.providerSettlements.id, settlementId));
  try {
    await database.transaction(async (tx) => {
      const [stl] = await tx.select().from(s.providerSettlements).where(eq(s.providerSettlements.id, settlementId));
      if (!stl) throw new Error("Settlement not found");
      if (stl.fulfilmentStatus === "fulfilled") return;
      const order = stl.order as ProviderOrder & { kind: UtilityKind; accountId: string };

      if (await isFaultEnabled("provider_fulfilment_failure")) {
        throw new Error("Simulated provider outage during fulfilment (demo fault injection)");
      }

      const product = resolveProduct(order.kind, order);
      const outcome = await applyFulfilment(tx, { kind: order.kind, product, accountId: order.accountId, txHash: stl.txHash, simNow });
      await tx.insert(s.fulfilments).values({
        id: newId("ful"),
        purchaseId: stl.purchaseId,
        settlementId: stl.id,
        providerId: stl.providerId,
        accountId: order.accountId,
        quantity: product.quantity,
        unit: product.unit,
        balanceBefore: outcome.balanceBefore,
        balanceAfter: outcome.balanceAfter,
        demoToken: outcome.demoToken,
        details: outcome.details,
        fulfilledAt: new Date(),
      });
      await tx
        .update(s.providerSettlements)
        .set({ fulfilmentStatus: "fulfilled", lastError: null, updatedAt: new Date() })
        .where(eq(s.providerSettlements.id, settlementId));
    });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Never downgrade a fulfilled settlement.
    await database
      .update(s.providerSettlements)
      .set({ fulfilmentStatus: "failed", lastError: error, updatedAt: new Date() })
      .where(and(eq(s.providerSettlements.id, settlementId), ne(s.providerSettlements.fulfilmentStatus, "fulfilled")));
    return { ok: false, error };
  }
}

/** POST /api/providers/:kind/fulfilment/retry — recovery without a second payment. */
export async function handleFulfilmentRetry(kind: UtilityKind, request: Request): Promise<Response> {
  const parsed = fulfilmentRetrySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { code: "invalid_request", message: "purchaseId is required." });
  const provider = PROVIDERS[kind];
  const stl = await findSettlement(provider.id, parsed.data.purchaseId);
  if (!stl) {
    return json(404, { code: "no_settlement", message: "No settled payment exists for this purchase. Nothing was charged." });
  }
  if (stl.fulfilmentStatus !== "fulfilled") {
    const database = db();
    const [account] = await database.select().from(s.utilityAccounts).where(eq(s.utilityAccounts.id, (stl.order as { accountId: string }).accountId));
    const [hh] = account ? await database.select().from(s.households).where(eq(s.households.id, account.householdId)) : [];
    const result = await fulfilSettlement(stl.id, hh?.simulatedNow ?? new Date());
    if (!result.ok) return json(502, { code: "fulfilment_failed", message: result.error, txHash: stl.txHash });
  }
  return json(200, await buildReceipt(stl.id));
}

async function findSettlement(providerId: string, purchaseId: string) {
  const [row] = await db()
    .select()
    .from(s.providerSettlements)
    .where(and(eq(s.providerSettlements.providerId, providerId), eq(s.providerSettlements.purchaseId, purchaseId)));
  return row;
}

async function buildReceipt(settlementId: string): Promise<ProviderReceipt> {
  const database = db();
  const [stl] = await database.select().from(s.providerSettlements).where(eq(s.providerSettlements.id, settlementId));
  if (!stl) throw new Error("Settlement not found");
  const [ful] = await database.select().from(s.fulfilments).where(eq(s.fulfilments.settlementId, settlementId));
  const order = stl.order as ProviderOrder & { kind: UtilityKind; accountId: string };
  const provider = PROVIDERS[order.kind];
  const product = resolveProduct(order.kind, order);
  return {
    receiptId: `rcp_${stl.id.slice(4)}`,
    simulated: true,
    disclaimer: "Simulated utility released by a demo provider. Paid with Stellar testnet USDC, which has no real-world value.",
    provider: { id: provider.id, name: provider.name, kind: order.kind },
    purchaseId: stl.purchaseId,
    recipient: { identifier: order.accountIdentifier, network: order.network ?? null },
    product: { code: product.code, label: product.label, amountNgn: product.amountNgn, quantity: product.quantity, unit: product.unit },
    payment: {
      status: "settled",
      network: stl.network,
      asset: stl.asset,
      amountAtomic: stl.amountAtomic,
      txHash: stl.txHash,
      payer: stl.payer,
      settledAt: stl.settledAt.toISOString(),
    },
    fulfilment: ful
      ? {
          status: "fulfilled",
          balanceBefore: ful.balanceBefore,
          balanceAfter: ful.balanceAfter,
          quantity: ful.quantity,
          unit: ful.unit,
          demoToken: ful.demoToken,
          details: (ful.details as Record<string, unknown>) ?? {},
          fulfilledAt: ful.fulfilledAt.toISOString(),
        }
      : { status: stl.fulfilmentStatus === "failed" ? "failed" : "pending", lastError: stl.lastError },
  };
}
