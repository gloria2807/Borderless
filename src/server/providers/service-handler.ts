/**
 * x402-protected INFORMATION services (procurement amendment A2), e.g.
 *   POST /api/services/:providerId/meter-diagnostic
 *
 * There is no quote step: the HTTP 402 IS the price — the provider's fixed, published
 * price for the service. Everything after the 402 is the same as a utility purchase:
 * facilitator verification, settlement on Stellar testnet, one settlement per payment,
 * and the result released only after settlement. Unpaid requests get HTTP 402 and nothing
 * else, so the agent cannot obtain the result without paying.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config/env";
import { db } from "../db/client";
import * as s from "../db/schema";
import { ngnToTestnetUsdcAtomic } from "../payments/pricing";
import { buildReceipt, challengeOrError, settleAndFulfil } from "./purchase-handler";
import type { ProviderModule } from "./types";
import type { PricedOrder } from "./x402-seller";

const json = (status: number, body: unknown) => Response.json(body, { status });

const serviceOrderSchema = z
  .object({
    accountIdentifier: z.string().trim().min(5).max(32),
    purchaseId: z.string().regex(/^pur_[0-9a-z]{10,40}$/),
    productCode: z.string().min(1).max(64).optional(),
  })
  .strict();

const globalLocks = globalThis as unknown as { __borderlessServiceLocks?: Set<string> };
const inFlight = (globalLocks.__borderlessServiceLocks ??= new Set());

export async function handleServicePurchase(module: ProviderModule, slug: string, request: Request): Promise<Response> {
  const provider = module.definition;
  if (!module.service || module.service.slug !== slug) return json(404, { code: "unknown_service", message: `${provider.name} offers no such service.` });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(400, { code: "invalid_json", message: "Request body must be JSON." });
  }
  const parsed = serviceOrderSchema.safeParse(raw);
  if (!parsed.success) return json(400, { code: "invalid_order", message: parsed.error.issues.map((i) => i.message).join("; ") });
  const order = parsed.data;

  const database = db();
  const [row] = await database.select().from(s.utilityProviders).where(eq(s.utilityProviders.id, provider.id));
  if (!row?.available) return json(503, { code: "provider_unavailable", message: `${provider.name} is currently unavailable (demo).` });

  const [account] = await database
    .select()
    .from(s.utilityAccounts)
    .where(and(eq(s.utilityAccounts.kind, provider.kind), eq(s.utilityAccounts.identifier, order.accountIdentifier)));
  if (!account) return json(404, { code: "unknown_account", message: `No ${provider.kind} account matches that identifier.` });

  const product = module.resolveProduct({ productCode: order.productCode });

  // Idempotency: a request that already settled returns the stored result, never a new charge.
  const [existing] = await database
    .select()
    .from(s.providerSettlements)
    .where(and(eq(s.providerSettlements.providerId, provider.id), eq(s.providerSettlements.purchaseId, order.purchaseId)));
  if (existing) {
    if (existing.fulfilmentStatus === "fulfilled") return Response.json(await buildReceipt(existing.id), { status: 200, headers: { "x-borderless-replay": "true" } });
    return json(409, {
      code: "settled_fulfilment_pending",
      message: "This request is already paid. Use the fulfilment retry endpoint to fetch the result — do not pay again.",
      txHash: existing.txHash,
    });
  }

  // The price is the provider's own published price for the service, at the demo rate.
  const priced: PricedOrder = {
    accountIdentifier: order.accountIdentifier,
    purchaseId: order.purchaseId,
    productCode: product.code,
    quoteAmountAtomic: ngnToTestnetUsdcAtomic(product.amountNgn, env().DEMO_NGN_PER_TESTNET_USDC).toString(),
  };

  const unpaid = !request.headers.get("payment-signature") && !request.headers.get("x-payment");
  if (unpaid) return challengeOrError(provider.id, request, priced);

  const lockKey = `${provider.id}:${order.purchaseId}`;
  if (inFlight.has(lockKey)) return json(409, { code: "purchase_in_progress", message: "A payment for this request is already being processed." });
  inFlight.add(lockKey);
  try {
    return await settleAndFulfil(module, request, priced, product, account.id);
  } finally {
    inFlight.delete(lockKey);
  }
}
