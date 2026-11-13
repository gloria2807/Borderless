/**
 * Test helper: a fetch that serves provider endpoints in-process.
 *  - /quote is served by the REAL quote handler (real validation, real quote rows);
 *  - /purchase and /fulfilment/retry go to the real handlers unless overridden.
 * Records every call so tests can assert what was (and was not) requested.
 */
import { vi } from "vitest";
import { handleFulfilmentRetry, handleProviderPurchase } from "@/server/providers/purchase-handler";
import { handleQuoteRequest } from "@/server/providers/quote-handler";
import { errorResponse, parseProviderId } from "@/server/providers/route-kind";

export interface ProviderFetchOptions {
  purchase?: (request: Request, body: Record<string, unknown>) => Response | Promise<Response>;
  quote?: (request: Request, body: Record<string, unknown>) => Response | Promise<Response>;
}

export function providerFetch(opts: ProviderFetchOptions = {}) {
  const calls: { kind: "quote" | "purchase" | "retry" | "other"; url: string; body: Record<string, unknown> | null }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const [, , , providerId, action] = url.pathname.split("/"); // /api/providers/:id/:action
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
    const kind = parseProviderId(providerId ?? "");
    const which = action === "quote" ? "quote" : action === "purchase" ? "purchase" : action === "fulfilment" ? "retry" : "other";
    calls.push({ kind: which, url: url.pathname, body });
    const request = new Request(url, init);
    try {
      if (!kind) return new Response(JSON.stringify({ code: "unknown_provider" }), { status: 404 });
      if (which === "quote") return opts.quote ? await opts.quote(request, body ?? {}) : await handleQuoteRequest(kind, request);
      if (which === "purchase") return opts.purchase ? await opts.purchase(request, body ?? {}) : await handleProviderPurchase(kind, request);
      if (which === "retry") return await handleFulfilmentRetry(kind, request);
      return new Response("{}", { status: 404 });
    } catch (err) {
      return errorResponse(err);
    }
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls, purchases: () => calls.filter((c) => c.kind === "purchase"), quotes: () => calls.filter((c) => c.kind === "quote") };
}

/** A base64 PAYMENT-REQUIRED header for an `exact` stellar:testnet requirement. */
export function paymentRequiredHeader(accepts: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "http://provider.test/purchase" }, accepts: [accepts] })).toString("base64");
}
