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
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { HTTPResponseInstructions } from "@x402/core/server";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { newId } from "../lib/ids";
import { isFaultEnabled } from "../demo/faults";
import { requireProvider } from "./registry";
import { ProductError, type Product, type ProviderModule, type Tx } from "./types";
import { fulfilmentRetrySchema, providerOrderSchema, type ProviderOrder } from "./order";
import { createRequestContext } from "./http-adapter";
import { getSeller, type PricedOrder } from "./x402-seller";
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

export async function handleProviderPurchase(module: ProviderModule, request: Request): Promise<Response> {
  const provider = module.definition;
  const kind = provider.kind;

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
  const rejection = module.validateOrder(order, account);
  if (rejection) return json(rejection.status, { code: rejection.code, message: rejection.message });

  let product;
  try {
    product = module.resolveProduct(order);
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

  // 3. The quote this purchase redeems. It fixes the price, recipient, product and payee.
  //    410 = gone: the provider refuses before any payment is verified, so nothing is charged.
  const [quote] = await database.select().from(s.providerQuotes).where(and(eq(s.providerQuotes.id, order.quoteId), eq(s.providerQuotes.providerId, provider.id)));
  if (!quote) return json(404, { code: "unknown_quote", message: "This provider issued no such quote. Request a new quote." });
  if (quote.redeemedByPurchaseId && quote.redeemedByPurchaseId !== order.purchaseId) {
    return json(410, { code: "quote_used", message: "This quote has already been redeemed by another purchase. Nothing was charged." });
  }
  if (quote.expiresAt.getTime() < Date.now()) {
    return json(410, { code: "quote_expired", message: "This quote has expired. Request a new quote. Nothing was charged." });
  }
  if (quote.accountIdentifier !== order.accountIdentifier || (quote.network ?? undefined) !== order.network || quote.productCode !== product.code) {
    return json(422, { code: "quote_mismatch", message: "The order does not match its quote (recipient, network or product)." });
  }
  const priced: PricedOrder = { ...order, quoteAmountAtomic: quote.amountAtomic };

  const lockKey = `${provider.id}:${order.purchaseId}`;
  if (context402Only(request)) {
    // Unpaid request: just return the 402 challenge (no lock needed).
    return challengeOrError(provider.id, request, priced);
  }
  if (inFlight.has(lockKey)) {
    return json(409, { code: "purchase_in_progress", message: "A payment for this purchase is already being processed." });
  }
  inFlight.add(lockKey);
  try {
    return await settleAndFulfil(module, request, priced, product, account.id);
  } finally {
    inFlight.delete(lockKey);
  }
}

function context402Only(request: Request): boolean {
  return !request.headers.get("payment-signature") && !request.headers.get("x-payment");
}

export async function challengeOrError(providerId: string, request: Request, order: PricedOrder): Promise<Response> {
  const seller = await getSeller(providerId);
  const result = await seller.processHTTPRequest(createRequestContext(request, order));
  if (result.type === "payment-error") return fromInstructions(result.response);
  // Any other result for an unpaid request would mean the route is misconfigured. Fail closed.
  return json(500, { code: "x402_misconfigured", message: "Payment protection is not active for this route." });
}

export async function settleAndFulfil(
  module: ProviderModule,
  request: Request,
  order: PricedOrder,
  product: Product,
  accountId: string,
): Promise<Response> {
  const provider = module.definition;
  const kind = provider.kind;
  const seller = await getSeller(provider.id);
  const context = createRequestContext(request, order);

  // 3. Verify with the facilitator. A failure here is definitive: nothing was submitted.
  let verified;
  try {
    verified = await seller.processHTTPRequest(context);
  } catch (err) {
    return json(503, {
      code: "facilitator_unavailable",
      phase: "verify",
      charged: false,
      message: `The payment facilitator could not verify the payment (${(err as Error).message}). Nothing was charged.`,
    });
  }
  if (verified.type === "payment-error") return fromInstructions(verified.response);
  if (verified.type !== "payment-verified") {
    return json(500, { code: "x402_misconfigured", message: "Payment protection is not active for this route." });
  }

  // 4. Settle on Stellar testnet via the facilitator. Nothing has been released yet.
  //    A failure here is NOT definitive: the transaction may still land on-chain.
  let settled;
  try {
    settled = await seller.processSettlement(
      verified.paymentPayload,
      verified.paymentRequirements,
      verified.declaredExtensions,
      { request: context },
    );
  } catch (err) {
    return json(502, {
      code: "settlement_unconfirmed",
      phase: "settle",
      message: `Settlement did not complete cleanly (${(err as Error).message}). The payment outcome must be reconciled before retrying.`,
    });
  }
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
  if (order.quoteId) {
    await database
      .update(s.providerQuotes)
      .set({ redeemedByPurchaseId: order.purchaseId })
      .where(and(eq(s.providerQuotes.id, order.quoteId), isNull(s.providerQuotes.redeemedByPurchaseId)));
  }

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
 * Generic device write: the provider module decides WHAT changes; this applies it
 * atomically (balance guarded by its previous value) and appends a usage record.
 */
async function applyToDevice(tx: Tx, providerId: string, product: Product, accountId: string, txHash: string, simNow: Date) {
  const [balance] = await tx.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, accountId));
  if (!balance) throw new Error(`Virtual device for account ${accountId} not found`);
  if (balance.unit !== product.unit) throw new Error(`Unit mismatch: device ${balance.unit}, product ${product.unit}`);

  const outcome = requireProvider(providerId).fulfil({ product, balance, txHash, simNow });
  const updated = await tx
    .update(s.utilityBalances)
    .set({ balance: outcome.balanceAfter, ...outcome.deviceUpdate, updatedAt: new Date() })
    .where(and(eq(s.utilityBalances.accountId, accountId), eq(s.utilityBalances.balance, balance.balance)))
    .returning({ accountId: s.utilityBalances.accountId });
  if (updated.length !== 1) throw new Error("Device balance changed concurrently; fulfilment will be retried");

  await tx.insert(s.usageRecords).values({
    id: newId("use"),
    accountId,
    simTime: simNow,
    delta: balance.balance - outcome.balanceAfter,
    balanceAfter: outcome.balanceAfter,
    source: "purchase",
  });
  return { ...outcome, balanceBefore: balance.balance };
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

      const module = requireProvider(stl.providerId);
      const product = module.resolveProduct(order);
      if (module.deliver) {
        // Information service: release the paid result. The household's devices are untouched.
        const result = await module.deliver({ tx: tx as unknown as Tx, accountId: order.accountId, simNow, txHash: stl.txHash, product });
        const [bal] = await tx.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, order.accountId));
        await tx.insert(s.fulfilments).values({
          id: newId("ful"),
          purchaseId: stl.purchaseId,
          settlementId: stl.id,
          providerId: stl.providerId,
          accountId: order.accountId,
          quantity: product.quantity,
          unit: product.unit,
          balanceBefore: bal?.balance ?? 0,
          balanceAfter: bal?.balance ?? 0,
          demoToken: null,
          details: { result },
          fulfilledAt: new Date(),
        });
        await tx
          .update(s.providerSettlements)
          .set({ fulfilmentStatus: "fulfilled", lastError: null, updatedAt: new Date() })
          .where(eq(s.providerSettlements.id, settlementId));
        return;
      }
      const outcome = await applyToDevice(tx, stl.providerId, product, order.accountId, stl.txHash, simNow);
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

/** POST /api/providers/:providerId/fulfilment/retry — recovery without a second payment. */
export async function handleFulfilmentRetry(module: ProviderModule, request: Request): Promise<Response> {
  const parsed = fulfilmentRetrySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { code: "invalid_request", message: "purchaseId is required." });
  const provider = module.definition;
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

export async function buildReceipt(settlementId: string): Promise<ProviderReceipt> {
  const database = db();
  const [stl] = await database.select().from(s.providerSettlements).where(eq(s.providerSettlements.id, settlementId));
  if (!stl) throw new Error("Settlement not found");
  const [ful] = await database.select().from(s.fulfilments).where(eq(s.fulfilments.settlementId, settlementId));
  const order = stl.order as ProviderOrder & { kind: UtilityKind; accountId: string };
  const provider = requireProvider(stl.providerId).definition;
  const product = requireProvider(stl.providerId).resolveProduct(order);
  return {
    receiptId: `rcp_${stl.id.slice(4)}`,
    simulated: true,
    disclaimer: requireProvider(stl.providerId).service
      ? "Simulated information service from a demo provider. Paid with Stellar testnet USDC, which has no real-world value."
      : "Simulated utility released by a demo provider. Paid with Stellar testnet USDC, which has no real-world value.",
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
