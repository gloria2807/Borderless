/**
 * Free quote endpoint: POST /api/providers/:providerId/quote
 *
 * A quote commits the provider to a product, recipient, NGN price, testnet USDC price
 * and payee for QUOTE_TTL_SECONDS. The provider's x402 price for a purchase is taken
 * from the quote it redeems, and a quote can be redeemed only once.
 */
import { and, eq } from "drizzle-orm";
import { env } from "../config/env";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import type { ProviderModule } from "./types";
import { newId } from "../lib/ids";
import { formatAtomic, TESTNET_USDC } from "../payments/pricing";
import { quoteRequestSchema } from "./order";
import { providerPayTo, requireProvider } from "./registry";
import { ProductError } from "./types";
import { quoteOrderAtomic } from "./x402-seller";

export const QUOTE_TTL_SECONDS = 300;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store, private" } });

export interface ProviderQuote {
  quoteId: string;
  providerId: string;
  providerName: string;
  utility: UtilityKind;
  recipient: { identifier: string; network: string | null };
  product: { code: string; label: string; quantity: number; unit: string; validityHours: number | null };
  amountNgn: number;
  payment: { scheme: "exact"; network: string; asset: string; amountAtomic: string; amountUsdc: string; payTo: string };
  issuedAt: string;
  expiresAt: string;
  simulated: true;
  note: string;
}

export function toProviderQuote(row: typeof s.providerQuotes.$inferSelect): ProviderQuote {
  const m = requireProvider(row.providerId);
  const kind: UtilityKind = m.definition.kind;
  const product = m.resolveProduct(kind === "data" ? { productCode: row.productCode } : { amountNgn: row.amountNgn });
  return {
    quoteId: row.id,
    providerId: row.providerId,
    providerName: m.definition.name,
    utility: kind,
    recipient: { identifier: row.accountIdentifier, network: row.network },
    product: { code: row.productCode, label: product.label, quantity: row.quantity, unit: row.unit, validityHours: product.validityHours ?? null },
    amountNgn: row.amountNgn,
    payment: { scheme: "exact", network: env().STELLAR_NETWORK, asset: row.asset, amountAtomic: row.amountAtomic, amountUsdc: formatAtomic(row.amountAtomic), payTo: row.payTo },
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    simulated: true,
    note: "Demo provider. Paid in Stellar testnet USDC (no monetary value); the utility released is simulated.",
  };
}

export async function handleQuoteRequest(module: ProviderModule, request: Request): Promise<Response> {
  const provider = module.definition;
  const kind = provider.kind;
  const parsed = quoteRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { code: "invalid_quote_request", message: parsed.error.issues.map((i) => i.message).join("; ") });
  const req = parsed.data;

  const database = db();
  const [providerRow] = await database.select().from(s.utilityProviders).where(eq(s.utilityProviders.id, provider.id));
  if (!providerRow?.available) return json(503, { code: "provider_unavailable", message: `${provider.name} is currently unavailable (demo).` });

  const [account] = await database
    .select()
    .from(s.utilityAccounts)
    .where(and(eq(s.utilityAccounts.kind, kind), eq(s.utilityAccounts.identifier, req.accountIdentifier)));
  if (!account) return json(404, { code: "unknown_account", message: `No ${kind} account matches that identifier.` });
  const rejection = module.validateOrder(req, account);
  if (rejection) return json(rejection.status, { code: rejection.code, message: rejection.message });

  let product;
  try {
    product = module.resolveProduct(req);
  } catch (err) {
    if (err instanceof ProductError) return json(422, { code: err.code, message: err.message });
    throw err;
  }

  const issuedAt = new Date();
  const [row] = await database
    .insert(s.providerQuotes)
    .values({
      id: newId("qt"),
      providerId: provider.id,
      accountIdentifier: req.accountIdentifier,
      network: req.network ?? null,
      productCode: product.code,
      amountNgn: product.amountNgn,
      quantity: product.quantity,
      unit: product.unit,
      amountAtomic: quoteOrderAtomic(provider.id, req).toString(),
      asset: TESTNET_USDC.contract,
      payTo: providerPayTo(provider.id),
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + QUOTE_TTL_SECONDS * 1000),
    })
    .returning();
  return json(200, toProviderQuote(row!));
}
