/**
 * "Request without paying" (amendment A4): the judge's test, live.
 *
 * Makes the same request the agent made to a provider's protected endpoint — same
 * provider, recipient and product — but WITHOUT any payment header, and returns the
 * provider's actual response. A correctly protected service answers HTTP 402 with payment
 * requirements and releases nothing. Utility endpoints first need a (free) quote, exactly
 * as the agent obtains one; information services are priced by the 402 itself.
 *
 * The probe uses a fresh purchase id, never the real one, so it can't touch the original
 * purchase's settlement or replay its receipt.
 */
import { eq } from "drizzle-orm";
import { env } from "../config/env";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { formatAtomic } from "../payments/pricing";
import { requireProvider } from "../providers/registry";
import { providerQuotePath, providerRoutePath } from "../providers/x402-seller";

export interface ProbeResult {
  request: { method: "POST"; path: string; body: Record<string, unknown>; paymentHeader: "none" };
  quote: { path: string; status: number; quoteId: string | null } | null;
  response: {
    status: number;
    statusText: string;
    paymentRequired: { x402Version: unknown; accepts: { scheme: string; network: string; asset: string; amount: string; amountUsdc: string; payTo: string }[] } | null;
    body: unknown;
  };
  /** True only if the provider released something without payment (a protection failure). */
  releasedWithoutPayment: boolean;
  at: string;
}

export async function probeUnpaid(db: Database, purchaseId: string): Promise<ProbeResult> {
  const [p] = await db.select().from(s.purchases).where(eq(s.purchases.id, purchaseId));
  if (!p) throw new Error("Purchase not found");
  const [account] = await db.select().from(s.utilityAccounts).where(eq(s.utilityAccounts.id, p.accountId));
  if (!account) throw new Error("Account not found");
  const module = requireProvider(p.providerId);
  const base = env().APP_BASE_URL;
  const post = (path: string, body: unknown) =>
    fetch(new URL(path, base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  const probeId = newId("pur");

  let path: string;
  let body: Record<string, unknown>;
  let quote: ProbeResult["quote"] = null;
  if (module.service) {
    path = `/api/services/${p.providerId}/${module.service.slug}`;
    body = { accountIdentifier: account.identifier, purchaseId: probeId, productCode: p.productCode };
  } else {
    const order = {
      accountIdentifier: account.identifier,
      ...(account.network ? { network: account.network } : {}),
      ...(p.kind === "data" ? { productCode: p.productCode } : { amountNgn: p.amountNgn }),
    };
    const qPath = providerQuotePath(p.providerId);
    const qRes = await post(qPath, order);
    const q = (await qRes.json().catch(() => null)) as { quoteId?: string } | null;
    quote = { path: qPath, status: qRes.status, quoteId: q?.quoteId ?? null };
    path = providerRoutePath(p.providerId);
    body = { ...order, purchaseId: probeId, quoteId: q?.quoteId ?? "" };
  }

  const res = await post(path, body);
  const header = res.headers.get("payment-required");
  let paymentRequired: ProbeResult["response"]["paymentRequired"] = null;
  if (header) {
    try {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { x402Version?: unknown; accepts?: Record<string, unknown>[] };
      paymentRequired = {
        x402Version: decoded.x402Version ?? null,
        accepts: (decoded.accepts ?? []).map((a) => ({
          scheme: String(a.scheme),
          network: String(a.network),
          asset: String(a.asset),
          amount: String(a.amount),
          amountUsdc: formatAtomic(String(a.amount)),
          payTo: String(a.payTo),
        })),
      };
    } catch {
      paymentRequired = null;
    }
  }
  const resBody = await res.json().catch(() => null);
  return {
    request: { method: "POST", path, body, paymentHeader: "none" },
    quote,
    response: { status: res.status, statusText: res.statusText, paymentRequired, body: resBody },
    releasedWithoutPayment: res.status === 200,
    at: new Date().toISOString(),
  };
}
