"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, RefreshCw, ScanSearch, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/primitives";
import { ConfirmButton, useApiAction } from "@/components/ui/interactive";
import { naira, UTILITY_NAMES } from "@/lib/format";
import { ApprovalTermsLine } from "@/components/agent/run-console";

type RunResult = { headline: string; outcome: string; purchases: { stage: string }[]; awaitingApproval: string[] };

export function RunAgentButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const { run, pending } = useApiAction();
  return (
    <Button
      variant={variant}
      loading={pending}
      onClick={() =>
        run<RunResult>("/api/agent/run", { body: { trigger: "manual" } }, {
          success: (d) => ({
            title: d.headline,
            body: d.purchases.length
              ? `${d.purchases.filter((p) => p.stage === "completed").length} of ${d.purchases.length} purchase${d.purchases.length === 1 ? "" : "s"} completed.`
              : d.awaitingApproval.length
                ? "A purchase is waiting for your approval."
                : undefined,
          }),
          errorTitle: "Borderless couldn't complete the assessment",
        })
      }
    >
      {!pending && <ScanSearch className="size-4" aria-hidden />}
      {pending ? "Assessing and paying…" : "Assess household now"}
    </Button>
  );
}

interface PendingPurchase {
  approvalTermsHash?: string | null;
  approvalTerms?: { amountAtomic: string; payTo: string; recipient: string } | null;
  approvalExpiresAt?: string | null;
  id: string;
  kind: "electricity" | "airtime" | "data";
  label: string;
  amountNgn: number;
  providerName?: string;
  reason?: string | null;
  failureMessage?: string | null;
  txHash?: string | null;
}

function useSecondsLeft(deadline: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : null;
}

/**
 * An approval request: the exact purchase, who sells it, what it costs in the owner's terms,
 * why Borderless wants it, what it does to the budget, and when the request lapses unpaid.
 */
export function ApprovalPrompt({ p, ngnPerUsdc, budgetLeftNgn, autoLimitNgn }: { p: PendingPurchase; ngnPerUsdc?: number; budgetLeftNgn?: number; autoLimitNgn?: number }) {
  const { run, pending } = useApiAction();
  const router = useRouter();
  const left = useSecondsLeft(p.approvalExpiresAt);
  const expired = left === 0;
  useEffect(() => {
    if (expired) router.refresh();
  }, [expired, router]);
  const usdc = (ngn: number) => (ngnPerUsdc ? `${(ngn / ngnPerUsdc).toFixed(2)} USDC` : naira(ngn));
  const mmss = left === null ? null : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <section aria-label="Approval request" className="relative overflow-hidden rounded-lg bg-surface py-3.5 pr-4 pl-5 shadow-ring">
      <span aria-hidden className={expired ? "absolute inset-y-0 left-0 w-[3px] bg-fg/15" : "absolute inset-y-0 left-0 w-[3px] bg-amber"} />
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-soft">
          <ShieldCheck className="size-4 text-amber" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="label mb-1 text-amber">{expired ? "Approval expired" : "Approval requested"}</p>
          <p className="text-[13.5px] font-semibold text-fg">
            Buy {p.label}
            {p.providerName ? <> from {p.providerName}</> : null} for <span className="tabular">{usdc(p.amountNgn)}</span>
            {ngnPerUsdc ? <span className="font-normal text-fg-3"> ({naira(p.amountNgn)})</span> : null}
          </p>
          <p className="mt-0.5 text-[12.5px] text-fg-2">
            {p.reason ? <>Why: {p.reason} </> : null}
            {p.reason ? "Nothing is paid unless you approve these exact terms." : autoLimitNgn !== undefined ? `It's above your ${usdc(autoLimitNgn)} automatic limit, so nothing is paid unless you approve these exact terms.` : "It's above your approval threshold, so nothing is paid unless you approve these exact terms."}
          </p>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11.5px]">
            {budgetLeftNgn !== undefined && (
              <div className="flex gap-1.5">
                <dt className="text-fg-3">Budget after</dt>
                <dd className="font-medium tabular">{usdc(Math.max(0, budgetLeftNgn))}</dd>
              </div>
            )}
            {mmss && (
              <div className="flex gap-1.5" aria-live="polite">
                <dt className="text-fg-3">{expired ? "Expired" : "Expires in"}</dt>
                <dd className="mono font-medium text-amber">{expired ? "unpaid" : mmss}</dd>
              </div>
            )}
          </dl>
          {p.approvalTerms && !expired && <ApprovalTermsLine t={p.approvalTerms} hash={p.approvalTermsHash ?? null} />}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={pending || expired} onClick={() => run(`/api/purchases/${p.id}/decline`, {}, { success: () => ({ title: "Purchase declined", body: "Nothing was paid." }) })}>
            Decline
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={pending}
            disabled={expired}
            onClick={() =>
              run<{ stage: string }>(`/api/purchases/${p.id}/approve`, { body: { termsHash: p.approvalTermsHash ?? undefined } }, {
                success: (d) => (d.stage === "completed" ? { title: "Approved and paid", body: `${UTILITY_NAMES[p.kind]} delivered to the virtual device.` } : { title: "Approved", body: "See the transaction for the payment outcome." }),
              })
            }
          >
            Approve and pay
          </Button>
        </div>
      </div>
    </section>
  );
}

export function AttentionPrompt({ p }: { p: PendingPurchase }) {
  const { run, pending } = useApiAction();
  return (
    <div className="relative flex flex-wrap items-center gap-x-4 gap-y-3 overflow-hidden rounded-lg bg-surface py-3.5 pr-4 pl-5 shadow-ring">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-coral" />
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-coral-soft">
        <CircleAlert className="size-4 text-coral" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="label mb-1 text-coral">Needs attention</p>
        <p className="text-[13.5px] font-semibold text-fg">
          {UTILITY_NAMES[p.kind]} purchase needs attention <span className="font-normal text-fg-2 tabular">{naira(p.amountNgn)}</span>
        </p>
        <p className="text-[12.5px] text-fg-2">{p.failureMessage ?? "The payment and fulfilment states need to be reconciled."}</p>
      </div>
      <div className="flex gap-2">
        <Link href={`/transactions/${p.id}`} className="inline-flex h-7 items-center rounded-full px-3 text-[12.5px] font-medium text-fg-2 hover:bg-fg/[0.06] hover:text-fg">
          Details
        </Link>
        <ConfirmButton
          size="sm"
          variant="primary"
          loading={pending}
          title="Retry without paying again?"
          body="Borderless will ask the provider to release the utility for the payment it already received, and re-check the payment on Stellar testnet. No new payment will be made."
          confirmLabel="Retry release"
          onConfirm={async () => {
            await run<{ stage: string }>(`/api/purchases/${p.id}/recover`, {}, {
              success: (d) => (d.stage === "completed" ? { title: "Utility released", body: "No second payment was made." } : { title: "Still unresolved", body: "Check the transaction for details." }),
            });
          }}
        >
          <RefreshCw className="size-3.5" /> Retry release
        </ConfirmButton>
      </div>
    </div>
  );
}
