"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button, cn } from "@/components/ui/primitives";
import { shortAddress } from "@/lib/format";
import type { ProbeResult } from "@/server/transactions/probe";

/**
 * The judge's test: send the same request again WITHOUT paying and show the provider's
 * actual response. Live, every time — nothing here is cached or pre-rendered.
 */
export function UnpaidProbe({ purchaseId }: { purchaseId: string }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const probe = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/purchases/${purchaseId}/probe-unpaid`, { method: "POST", headers: { "content-type": "application/json" } });
      const data = (await res.json()) as ProbeResult & { message?: string };
      if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  const r = result?.response;
  return (
    <div className="rounded-md border border-line bg-bg-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-fg">Remove the payment</p>
          <p className="mt-0.5 text-2xs text-fg-3">Send this exact request to the provider again, with no payment. A paid service must refuse with HTTP 402 and release nothing.</p>
        </div>
        <Button size="sm" variant="secondary" loading={pending} onClick={() => void probe()}>
          {!pending && <ShieldAlert className="size-4" aria-hidden />}
          Request without paying
        </Button>
      </div>

      <div aria-live="polite">
        {error && <p className="mt-3 text-2xs text-coral">{error}</p>}
        {result && r && (
          <div className="mt-3 space-y-2 text-2xs">
            {result.quote && (
              <p className="text-fg-3">
                Free quote first: <span className="mono text-fg-2">POST {result.quote.path}</span> → {result.quote.status}
              </p>
            )}
            <p className="mono text-fg-2">
              POST {result.request.path} · no PAYMENT-SIGNATURE header
            </p>
            <p className={cn("mono text-sm font-semibold", r.status === 402 ? "text-amber" : result.releasedWithoutPayment ? "text-coral" : "text-fg")}>
              HTTP {r.status} {r.statusText}
            </p>
            {r.paymentRequired?.accepts.map((a, i) => (
              <dl key={i} className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                <dt className="text-fg-3">Scheme</dt>
                <dd className="mono text-fg-2">{a.scheme}</dd>
                <dt className="text-fg-3">Network</dt>
                <dd className="mono text-fg-2">{a.network}</dd>
                <dt className="text-fg-3">Asks for</dt>
                <dd className="mono text-fg-2">{a.amountUsdc} test USDC</dd>
                <dt className="text-fg-3">Pay to</dt>
                <dd className="mono text-fg-2" title={a.payTo}>{shortAddress(a.payTo)}</dd>
              </dl>
            ))}
            <p className={result.releasedWithoutPayment ? "font-semibold text-coral" : "text-green"}>
              {result.releasedWithoutPayment ? "The provider released something without payment — protection failure." : "Nothing was released. Without payment, the resource is unavailable."}
            </p>
            <details>
              <summary className="cursor-pointer text-fg-3 hover:text-fg">Response body</summary>
              <pre tabIndex={0} aria-label="Response body" className="mono mt-1 max-h-48 overflow-auto rounded-sm bg-bg p-2 whitespace-pre-wrap text-fg-2">{JSON.stringify(r.body, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
