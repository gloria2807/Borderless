import type { HTTPAdapter, HTTPRequestContext } from "@x402/core/server";

/**
 * Minimal x402 HTTPAdapter over a Web `Request` whose JSON body has already been read
 * (bodies can only be consumed once, and our dynamic price needs the parsed order).
 */
export function createRequestContext(request: Request, body: unknown): HTTPRequestContext {
  const url = new URL(request.url);
  const adapter: HTTPAdapter = {
    getHeader: (name) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => request.url,
    getAcceptHeader: () => request.headers.get("accept") ?? "",
    getUserAgent: () => request.headers.get("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name) => url.searchParams.get(name) ?? undefined,
    getBody: () => body,
  };
  return {
    adapter,
    path: url.pathname,
    method: request.method,
    paymentHeader: request.headers.get("payment-signature") ?? request.headers.get("x-payment") ?? undefined,
  };
}
