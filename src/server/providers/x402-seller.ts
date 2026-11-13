/**
 * Provider-side x402 configuration (the "seller").
 *
 * Each provider instance has its own receiving wallet and its own x402 resource server,
 * talking to the configured facilitator. The price comes from the provider's own quote
 * for the order — never from anything the client claims to be paying.
 */
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPRequestContext,
} from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { env } from "../config/env";
import { isFaultEnabled } from "../demo/faults";
import { ngnToTestnetUsdcAtomic, TESTNET_USDC } from "../payments/pricing";
import type { ProviderOrder } from "./order";
import { providerPayTo, requireProvider } from "./registry";
import type { OrderInput } from "./types";

/** Payment requirements stay valid for 5 minutes. */
export const PAYMENT_TIMEOUT_SECONDS = 300;

/** Provider endpoints are keyed by provider id, so several providers can serve one utility. */
export const providerRoutePath = (providerId: string) => `/api/providers/${providerId}/purchase`;
export const providerRetryPath = (providerId: string) => `/api/providers/${providerId}/fulfilment/retry`;
export const providerQuotePath = (providerId: string) => `/api/providers/${providerId}/quote`;

/**
 * The order as the seller prices it: the validated body plus the price. For utilities the
 * price comes from the redeemed quote; for information services it is the service's fixed
 * published price (the HTTP 402 itself is the price — there is no quote step).
 */
export type PricedOrder = Omit<ProviderOrder, "quoteId"> & { quoteId?: string; quoteAmountAtomic: string };

/** Atomic testnet USDC for a provider's product at the household demo rate. */
export function quoteOrderAtomic(providerId: string, order: Pick<OrderInput, "amountNgn" | "productCode">): bigint {
  const product = requireProvider(providerId).resolveProduct(order);
  return ngnToTestnetUsdcAtomic(product.amountNgn, env().DEMO_NGN_PER_TESTNET_USDC);
}

function orderFromContext(context: HTTPRequestContext): PricedOrder {
  const body = context.adapter.getBody?.() as PricedOrder | undefined;
  if (!body) throw new Error("Order body missing from request context");
  return body;
}

type Cached = { server: x402HTTPResourceServer; ready: Promise<void> };
const globalForSeller = globalThis as unknown as { __borderlessSellersById?: Map<string, Cached> };
const sellers = (globalForSeller.__borderlessSellersById ??= new Map());

export function createFacilitatorClient(): HTTPFacilitatorClient {
  const e = env();
  const apiKey = e.X402_FACILITATOR_API_KEY;
  return new HTTPFacilitatorClient({
    url: e.X402_FACILITATOR_URL,
    timeoutMs: 60_000,
    createAuthHeaders: apiKey
      ? async () => {
          const h = { Authorization: `Bearer ${apiKey}` };
          return { verify: h, settle: h, supported: h };
        }
      : undefined,
  });
}

/** Lazily built, initialised (facilitator /supported fetched) once per process and provider. */
export async function getSeller(providerId: string): Promise<x402HTTPResourceServer> {
  let cached = sellers.get(providerId);
  if (!cached) {
    const e = env();
    const module = requireProvider(providerId);
    const provider = module.definition;
    const payTo = providerPayTo(providerId);
    const resourceServer = new x402ResourceServer(createFacilitatorClient()).register(e.STELLAR_NETWORK, new ExactStellarScheme());
    const paidPath = module.service ? `/api/services/${providerId}/${module.service.slug}` : providerRoutePath(providerId);
    const server = new x402HTTPResourceServer(resourceServer, {
      [`POST ${paidPath}`]: {
        accepts: {
          scheme: "exact",
          network: e.STELLAR_NETWORK,
          payTo,
          maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
          // The price is the provider's own quote, fixed when the quote was issued.
          // (Demo fault "provider_quote_mismatch" makes the provider ask for more than it quoted.)
          price: async (context) => {
            const quoted = BigInt(orderFromContext(context).quoteAmountAtomic);
            const amount = (await isFaultEnabled("provider_quote_mismatch")) ? (quoted * 11n) / 10n : quoted;
            return { asset: TESTNET_USDC.contract, amount: amount.toString() };
          },
        },
        description: module.service ? `${provider.name} — simulated ${module.service.title.toLowerCase()} (Stellar testnet demo)` : `${provider.name} — simulated ${provider.kind} purchase (Stellar testnet demo)`,
        mimeType: "application/json",
        serviceName: provider.name,
        unpaidResponseBody: (context) => {
          const order = orderFromContext(context);
          const product = module.resolveProduct(order);
          return {
            contentType: "application/json",
            body: {
              code: "payment_required",
              message: module.service
                ? `Pay with Stellar testnet USDC via x402 to receive this ${module.service.title.toLowerCase()} (simulated).`
                : "Pay with Stellar testnet USDC via x402 to release this simulated utility.",
              order: { purchaseId: order.purchaseId, quoteId: order.quoteId, product: product.label, amountNgn: product.amountNgn },
              simulated: true,
            },
          };
        },
      },
    });
    cached = { server, ready: server.initialize() };
    sellers.set(providerId, cached);
    // A failed init (e.g. facilitator down) must not poison the cache forever.
    cached.ready.catch(() => sellers.delete(providerId));
  }
  await cached.ready;
  return cached.server;
}
