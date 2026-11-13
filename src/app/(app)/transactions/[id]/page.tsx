import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, CircleCheck, CircleDashed, CircleX, Zap } from "lucide-react";
import { ActivityTimeline } from "@/components/agent/activity-timeline";
import { ApprovalPrompt, AttentionPrompt } from "@/components/agent/actions";
import { DiagnosticReport, isDiagnosticReport } from "@/components/agent/diagnostic-report";
import { cn, KeyValue, Panel, SimulatedTag, StatusPill, TestnetTag } from "@/components/ui/primitives";
import { atomicToDecimal, fullTimestamp, maskMsisdn, meterId, naira, NETWORK_NAMES, quantity, UTILITY_NAMES } from "@/lib/format";
import { FULFILMENT_STATUS, PAYMENT_STATUS, STAGE, type Tone } from "@/lib/status";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { TESTNET_USDC } from "@/server/payments/pricing";
import { getPurchaseDetail } from "@/server/views/household";

export const dynamic = "force-dynamic";

const LINE_LABEL: Record<string, string> = { fact: "Fact", observation: "Observed", prediction: "Predicted", decision: "Decision", constraint: "Held back" };

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return { title: `Transaction ${(await params).id}` };
}

/** One of the two receipts. They are deliberately never merged. */
function StateBlock({ title, tag, tone, heading, body }: { title: string; tag: React.ReactNode; tone: Tone; heading: string; body: string }) {
  const Icon = tone === "positive" ? CircleCheck : tone === "critical" ? CircleX : CircleDashed;
  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        tone === "positive" && "border-green/30 bg-green-soft",
        tone === "critical" && "border-coral/30 bg-coral-soft",
        tone === "warning" && "border-amber/30 bg-amber-soft",
        (tone === "neutral" || tone === "progress" || tone === "info") && "border-line bg-surface",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-fg-2">{title}</p>
        {tag}
      </div>
      <p className={cn("mt-3 flex items-center gap-2 text-base font-semibold", tone === "positive" ? "text-green" : tone === "critical" ? "text-coral" : tone === "warning" ? "text-amber" : "text-fg")}>
        <Icon className="size-4.5" aria-hidden />
        {heading}
      </p>
      <p className="mt-1 text-[13px] text-fg-2">{body}</p>
    </div>
  );
}

export default async function TransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getPurchaseDetail(DEMO_HOUSEHOLD, id);
  if (!detail) notFound();
  const { purchase: p, payment, receipt, events, decisionReasoning, decisionLines } = detail;
  const pay = PAYMENT_STATUS[p.paymentStatus]!;
  const ful = FULFILMENT_STATUS[p.fulfilmentStatus]!;
  const releasedResult = (receipt as { fulfilment?: { details?: { result?: unknown } } } | null)?.fulfilment?.details?.result;
  const report = isDiagnosticReport(releasedResult) ? releasedResult : null;
  const stage = STAGE[p.stage]!;
  const r = receipt as {
    receiptId?: string;
    fulfilment?: { status: string; balanceBefore?: number; balanceAfter?: number; quantity?: number; unit?: string; demoToken?: string | null; details?: Record<string, unknown>; fulfilledAt?: string };
    disclaimer?: string;
  } | null;
  const recipient = p.kind === "electricity" ? `Meter ${meterId(p.recipient)}` : `${NETWORK_NAMES[p.network ?? ""] ?? ""} ${maskMsisdn(p.recipient)}`;

  return (
    <>
      <Link href="/transactions" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-2 hover:text-fg">
        <ArrowLeft className="size-3.5" /> Transactions
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mono text-2xs text-fg-3">{p.id}</p>
          <h1 className="mt-1 text-xl font-bold tracking-[-0.01em]">
            {p.label} <span className="font-medium text-fg-3">for {recipient}</span>
          </h1>
          <p className="mt-1 text-[13px] text-fg-2">
            {p.initiatedBy === "owner" ? "Bought by the household owner" : "Bought by Borderless"}, {UTILITY_NAMES[p.kind].toLowerCase()} from {p.providerName}
          </p>
        </div>
        <StatusPill tone={stage.tone} pulse={false}>
          {stage.label}
        </StatusPill>
      </div>

      {p.stage === "awaiting_approval" && <div className="mb-6"><ApprovalPrompt p={p} /></div>}
      {p.stage === "needs_attention" && <div className="mb-6"><AttentionPrompt p={p} /></div>}

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <StateBlock
          title="Payment"
          tag={<TestnetTag />}
          tone={pay.tone}
          heading={pay.label}
          body={p.paymentStatus === "failed" && p.failureMessage ? p.failureMessage : pay.hint}
        />
        <StateBlock
          title={report ? "Service fulfilment" : "Utility fulfilment"}
          tag={<SimulatedTag />}
          tone={ful.tone}
          heading={p.fulfilmentStatus === "fulfilled" ? (report ? "Report released" : "Utility fulfilment confirmed") : ful.label}
          body={p.fulfilmentStatus === "failed" && p.failureMessage ? p.failureMessage : ful.hint}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Panel title="Payment record" description="x402 on Stellar testnet. Testnet USDC has no monetary value.">
            <dl className="divide-y divide-line-soft">
              <KeyValue label="Purchase amount (household value)" mono>{naira(p.amountNgn)}</KeyValue>
              <KeyValue label="Testnet payment" mono>{payment?.amountAtomic ? `${atomicToDecimal(payment.amountAtomic)} USDC` : "None"}</KeyValue>
              <KeyValue label="Asset">
                <span className="mono text-fg-2" title={payment?.asset ?? TESTNET_USDC.contract}>USDC (testnet), {(payment?.asset ?? TESTNET_USDC.contract).slice(0, 8)}…</span>
              </KeyValue>
              <KeyValue label="Network and scheme" mono>{payment ? `${payment.network}, ${payment.scheme ?? "exact"}` : "stellar:testnet"}</KeyValue>
              <KeyValue label="Status">{pay.label}</KeyValue>
              <KeyValue label="Paid to (provider wallet)" mono>{payment?.payTo ?? "None"}</KeyValue>
              <KeyValue label="Paid from (agent wallet)" mono>{payment?.payer ?? "None"}</KeyValue>
              <KeyValue label="Transaction hash" mono>
                {payment?.txHash ? (
                  <a href={p.explorerUrl!} target="_blank" rel="noreferrer" className="inline-flex items-start gap-1 text-cyan hover:underline">
                    {payment.txHash} <ArrowUpRight className="mt-0.5 size-3 shrink-0" aria-hidden />
                  </a>
                ) : (
                  "None, no payment was submitted on-chain"
                )}
              </KeyValue>
              {payment?.ledger && <KeyValue label="Confirmed in ledger" mono>{payment.ledger.toLocaleString("en-NG")}</KeyValue>}
              {payment?.settledAt && <KeyValue label="Settled" mono>{fullTimestamp(payment.settledAt)}</KeyValue>}
              {payment?.confirmedAt && <KeyValue label="Verified on Horizon" mono>{fullTimestamp(payment.confirmedAt)}</KeyValue>}
              {payment?.errorCode && <KeyValue label="Error" mono>{payment.errorCode}</KeyValue>}
            </dl>
          </Panel>

          <Panel title="Fulfilment receipt" description="Issued by the demo provider after settlement" actions={<SimulatedTag />}>
            {r?.fulfilment?.status === "fulfilled" && report ? (
              <>
                <dl className="mb-4 divide-y divide-line-soft">
                  <KeyValue label="Receipt" mono>{r.receiptId}</KeyValue>
                  <KeyValue label="About">{recipient}</KeyValue>
                  {r.fulfilment.fulfilledAt && <KeyValue label="Released at" mono>{fullTimestamp(r.fulfilment.fulfilledAt)}</KeyValue>}
                </dl>
                <DiagnosticReport report={report} />
                <details className="mt-4 rounded-md border border-line-soft bg-bg-2">
                  <summary className="cursor-pointer px-3 py-2 text-2xs font-medium text-fg-2 hover:text-fg">Provider receipt (JSON)</summary>
                  <pre className="mono max-h-80 overflow-auto px-3 pb-3 text-2xs leading-relaxed text-fg-2">{JSON.stringify(receipt, null, 2)}</pre>
                </details>
              </>
            ) : r?.fulfilment?.status === "fulfilled" ? (
              <>
                <dl className="divide-y divide-line-soft">
                  <KeyValue label="Receipt" mono>{r.receiptId}</KeyValue>
                  <KeyValue label="Recipient">{recipient}</KeyValue>
                  <KeyValue label="Released" mono>{quantity(r.fulfilment.quantity ?? p.quantity, r.fulfilment.unit ?? p.unit, { precise: true })}</KeyValue>
                  <KeyValue label="Balance before" mono>{quantity(r.fulfilment.balanceBefore ?? 0, p.unit, { precise: true })}</KeyValue>
                  <KeyValue label="Balance after" mono>{quantity(r.fulfilment.balanceAfter ?? 0, p.unit, { precise: true })}</KeyValue>
                  {r.fulfilment.demoToken && <KeyValue label="Demo token (not valid on real meters)" mono>{r.fulfilment.demoToken}</KeyValue>}
                  {typeof r.fulfilment.details?.reference === "string" && <KeyValue label="Recharge reference" mono>{r.fulfilment.details.reference}</KeyValue>}
                  {typeof r.fulfilment.details?.expiresAt === "string" && <KeyValue label="Bundle expires" mono>{fullTimestamp(r.fulfilment.details.expiresAt)}</KeyValue>}
                  {r.fulfilment.fulfilledAt && <KeyValue label="Released at" mono>{fullTimestamp(r.fulfilment.fulfilledAt)}</KeyValue>}
                </dl>
                <details className="mt-4 rounded-md border border-line-soft bg-bg-2">
                  <summary className="cursor-pointer px-3 py-2 text-2xs font-medium text-fg-2 hover:text-fg">Provider receipt (JSON)</summary>
                  <pre className="mono max-h-80 overflow-auto px-3 pb-3 text-2xs leading-relaxed text-fg-2">{JSON.stringify(receipt, null, 2)}</pre>
                </details>
              </>
            ) : (
              <p className="text-[13px] text-fg-3">
                {p.fulfilmentStatus === "failed"
                  ? "The provider has not released the utility yet. Retrying does not charge again."
                  : p.paymentStatus === "failed"
                    ? "No receipt: the purchase stopped before any payment, so the provider released nothing."
                    : "No receipt yet."}
              </p>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          {decisionReasoning && (
            <Panel title="Why Borderless bought this" actions={<Zap className="size-4 text-fg-3" aria-hidden />}>
              {decisionLines.length ? (
                <ul className="space-y-2.5">
                  {decisionLines.map((l, i) => (
                    <li key={i} className="text-[13px] leading-relaxed">
                      <span className="mr-2 text-2xs font-semibold text-fg-3">{LINE_LABEL[l.kind] ?? l.kind}</span>
                      <span className={l.kind === "decision" ? "text-fg" : "text-fg-2"}>{l.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] leading-relaxed text-fg-2">{decisionReasoning}</p>
              )}
            </Panel>
          )}
          <Panel title="Timeline" description="Every step, in order" bodyClassName="px-5 pt-5 pb-1">
            {/* getPurchaseDetail already returns events oldest-first. */}
            <ActivityTimeline events={events} />
          </Panel>
        </div>
      </div>
    </>
  );
}
