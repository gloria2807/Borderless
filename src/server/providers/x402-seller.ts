/**
 * Provider-side x402 configuration (the "seller").
 *
 * Each provider has its own receiving wallet and its own x402 resource server,
 * talking to the configured facilitator. Price and payTo are derived from the
 * validated order — never from anything the client claims to be paying.
 */
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPRequestContext,
} from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { env, providerPayTo } from "../config/env";
import type { UtilityKind } from "../db/schema";
import { ngnToTestnetUsdcAtomic, TESTNET_USDC } from "../payments/pricing";
import { PROVIDERS, resolveProduct } from "./registry";
import type { ProviderOrder } from "./order";

/** Payment requirements stay valid for 5 minutes. */
export const PAYMENT_TIMEOUT_SECONDS = 300;

export function providerRoutePath(kind: UtilityKind): string {
  return `/api/providers/${kind}/purchase`;
}

/** Atomic testnet USDC price for an order — the single pricing function used by seller AND buyer. */
export function quoteOrderAtomic(kind: UtilityKind, order: Pick<ProviderOrder, "amountNgn" | "productCode">): bigint {
  const product = resolveProduct(kind, order);
  return ngnToTestnetUsdcAtomic(product.amountNgn, env().DEMO_NGN_PER_TESTNET_USDC);
}

function orderFromContext(context: HTTPRequestContext): ProviderOrder {
  const body = context.adapter.getBody?.() as ProviderOrder | undefined;
  if (!body) throw new Error("Order body missing from request context");
  return body;
}

type Cached = { server: x402HTTPResourceServer; ready: Promise<void> };
const globalForSeller = globalThis as unknown as { __borderlessSellers?: Map<UtilityKind, Cached> };
const sellers = (globalForSeller.__borderlessSellers ??= new Map());

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
export async function getSeller(kind: UtilityKind): Promise<x402HTTPResourceServer> {
  let cached = sellers.get(kind);
  if (!cached) {
    const e = env();
    const payTo = providerPayTo(kind);
    const provider = PROVIDERS[kind];
    const resourceServer = new x402ResourceServer(createFacilitatorClient()).register(
      e.STELLAR_NETWORK,
      new ExactStellarScheme(),
    );
    const server = new x402HTTPResourceServer(resourceServer, {
      [`POST ${providerRoutePath(kind)}`]: {
        accepts: {
          scheme: "exact",
          network: e.STELLAR_NETWORK,
          payTo,
          maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
          price: (context) => ({
            asset: TESTNET_USDC.contract,
            amount: quoteOrderAtomic(kind, orderFromContext(context)).toString(),
          }),
        },
        description: `${provider.name} — simulated ${kind} purchase (Stellar testnet demo)`,
        mimeType: "application/json",
        serviceName: provider.name,
        unpaidResponseBody: (context) => {
          const order = orderFromContext(context);
          const product = resolveProduct(kind, order);
          return {
            contentType: "application/json",
            body: {
              code: "payment_required",
              message: "Pay with Stellar testnet USDC via x402 to release this simulated utility.",
              order: { purchaseId: order.purchaseId, product: product.label, amountNgn: product.amountNgn },
              simulated: true,
            },
          };
        },
      },
    });
    cached = { server, ready: server.initialize() };
    sellers.set(kind, cached);
    // A failed init (e.g. facilitator down) must not poison the cache forever.
    cached.ready.catch(() => sellers.delete(kind));
  }
  await cached.ready;
  return cached.server;
}
