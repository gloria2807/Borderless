/**
 * Shared helpers for the app's own JSON API (not the provider endpoints).
 *
 * The demo has a single household and no login. Mutating routes therefore reject
 * cross-site requests (Origin must match Host) so another website cannot drive the
 * agent's wallet from a visitor's browser.
 */
import { z } from "zod";
import { AgentBusyError } from "./agent/run";
import { HouseholdNotFoundError } from "./household/state";
import { ProductError } from "./providers/types";
import { ApprovalExpiredError, ApprovalStateError, ApprovalTermsChangedError, ApprovalTermsRequiredError } from "./transactions/approvals";
import { PolicyDeniedError, PurchaseConflictError } from "./transactions/purchases";
import { ConfigurationError } from "./config/env";

export const DEMO_HOUSEHOLD = "hh_demo";

export const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => ok({ code, message, ...extra }, status);

export function sameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return null; // same-origin fetches from older browsers / server-side callers
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    if (host && new URL(origin).host === host) return null;
  } catch {
    /* fall through */
  }
  return fail(403, "cross_origin", "Cross-site requests are not allowed.");
}

export async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | Response> {
  const raw = await request.json().catch(() => undefined);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return fail(400, "invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

export function handleError(err: unknown): Response {
  if (err instanceof PolicyDeniedError) return fail(422, err.code, err.message, { violations: err.violations });
  if (err instanceof PurchaseConflictError) return fail(409, err.code, err.message, { purchaseId: err.existingPurchaseId });
  if (err instanceof AgentBusyError) return fail(409, err.code, err.message);
  if (err instanceof ApprovalStateError) return fail(409, err.code, err.message);
  if (err instanceof ApprovalExpiredError) return fail(410, err.code, err.message);
  if (err instanceof ApprovalTermsRequiredError) return fail(400, err.code, err.message);
  if (err instanceof ApprovalTermsChangedError) return fail(409, err.code, err.message, { changed: err.changed });
  if (err instanceof ProductError) return fail(422, err.code, err.message);
  if (err instanceof HouseholdNotFoundError) return fail(404, err.code, err.message);
  if (err instanceof ConfigurationError) return fail(503, err.code, err.message);
  console.error("[api]", err);
  return fail(500, "internal_error", err instanceof Error ? err.message : "Unexpected error");
}

/** Wrap a mutating route: same-origin check + uniform error handling. */
export function action(handler: (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>) {
  return async (request: Request, ctx: { params: Promise<Record<string, string>> }) => {
    const blocked = sameOrigin(request);
    if (blocked) return blocked;
    try {
      return await handler(request, ctx);
    } catch (err) {
      return handleError(err);
    }
  };
}
