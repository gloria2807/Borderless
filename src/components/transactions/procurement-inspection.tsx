import type { ReactNode } from "react";
import { ArrowUpRight, Check, Minus } from "lucide-react";
import { DiagnosticReport, isDiagnosticReport } from "@/components/agent/diagnostic-report";
import { cn, StatusPill } from "@/components/ui/primitives";
import { fullTimestamp, naira, quantity, shortAddress } from "@/lib/format";
import type { ProcurementView } from "@/server/views/procurement";
import { UnpaidProbe } from "./unpaid-probe";

function Row({ n, step, children }: { n: number; step: ProcurementView["steps"][number]; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 py-3">
      <span
        className={cn(
          "mt-0.5 grid size-6 place-items-center rounded-full border text-2xs font-semibold",
          step.status === "recorded" ? "border-green/40 bg-green-soft text-green" : "border-line text-fg-3",
        )}
        aria-hidden
      >
        {step.status === "recorded" ? <Check className="size-3" /> : step.status === "not_applicable" ? <Minus className="size-3" /> : n}
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-fg">
          {n}. {step.title}
          {step.status !== "recorded" && <span className="ml-2 text-2xs font-normal text-fg-3">{step.status === "not_applicable" ? "not needed for this purchase" : "not reached"}</span>}
        </p>
        <div className="mt-1 text-[13px] text-fg-2">{children}</div>
      </div>
    </li>
  );
}

const Mono = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span className="mono break-all text-fg-2" title={title}>
    {children}
  </span>
);

/** Every step of one paid acquisition, from recorded backend data only. */
export function ProcurementInspection({ v }: { v: ProcurementView }) {
  const step = (key: string) => v.steps.find((s) => s.key === key)!;
  const accept = v.http402?.accepts[0];
  return (
    <div className="space-y-4">
      <ol className="divide-y divide-line-soft">
        <Row n={1} step={step("provider")}>
          {v.provider.name} · {v.provider.category === "intelligence" ? "information service" : "utility seller"}{" "}
          <StatusPill tone={v.provider.verified ? "positive" : "critical"} pulse={false}>
            {v.provider.verified ? "Verified against registry" : "Unverified"}
          </StatusPill>
          <p className="mt-1 text-2xs text-fg-3">
            {v.discovery.inRun ? `Discovered over HTTP by the agent (${v.discovery.tool}) at ${fullTimestamp(v.discovery.at!)}.` : "Not discovered in an agent run (bought directly or by the deterministic engine)."} Registered payee{" "}
            <Mono title={v.provider.registeredPayTo ?? undefined}>{v.provider.registeredPayTo ? shortAddress(v.provider.registeredPayTo) : "—"}</Mono>.{" "}
            <a href={v.provider.serviceDocument} className="text-cyan hover:underline">
              Published document
            </a>
          </p>
        </Row>
        <Row n={2} step={step("description")}>
          <span className="text-2xs text-fg-3">Published by the provider (untrusted): </span>
          {v.provider.description}
        </Row>
        <Row n={3} step={step("endpoint")}>
          <Mono>
            {v.endpoint.method} {v.endpoint.path}
          </Mono>{" "}
          · paid through {v.endpoint.protocol}
        </Row>
        <Row n={4} step={step("http402")}>
          {v.http402 ? (
            <>
              <Mono>HTTP 402 Payment Required</Mono> · x402 version {String(v.http402.x402Version)} · {v.http402.accepts.length} payment option{v.http402.accepts.length === 1 ? "" : "s"}
              <details className="mt-1">
                <summary className="cursor-pointer text-2xs text-fg-3 hover:text-fg">Decoded PAYMENT-REQUIRED</summary>
                <pre tabIndex={0} aria-label="Decoded payment requirements" className="mono mt-1 max-h-60 overflow-auto rounded-sm bg-bg p-2 text-[11px] whitespace-pre-wrap text-fg-2">
                  {JSON.stringify(v.http402.raw, null, 2)}
                </pre>
              </details>
            </>
          ) : (
            "No 402 was received: the purchase stopped before requesting payment."
          )}
        </Row>
        <Row n={5} step={step("price")}>
          {naira(v.price.amountNgn)} = <Mono>{v.price.amountUsdc ?? "—"} test USDC</Mono> ·{" "}
          {v.price.source === "quote" ? (
            <>
              binding quote <Mono>{v.price.quoteId ?? "—"}</Mono>
              {v.price.expiresAt && <> (valid until {fullTimestamp(v.price.expiresAt)})</>}
            </>
          ) : (
            "the provider's published price, stated by its HTTP 402 (no quote step)"
          )}
        </Row>
        <Row n={6} step={step("asset")}>
          {accept ? (
            <>
              <Mono>{accept.scheme}</Mono> on <Mono>{accept.network}</Mono>, asset <Mono title={accept.asset}>{accept.asset.slice(0, 8)}…</Mono> (test USDC), {accept.amountUsdc} to{" "}
              <Mono title={accept.payTo}>{shortAddress(accept.payTo)}</Mono>
              {v.provider.registeredPayTo && <span className="text-2xs text-fg-3"> {accept.payTo === v.provider.registeredPayTo ? "· matches the registered payee" : "· DOES NOT match the registered payee"}</span>}
            </>
          ) : (
            "—"
          )}
        </Row>
        <Row n={7} step={step("policy")}>
          {v.policy ? (
            <>
              <span className={v.policy.outcome === "deny" ? "font-semibold text-coral" : "font-semibold text-green"}>{v.policy.outcome === "deny" ? "Refused" : v.policy.outcome === "require_approval" ? "Needs approval" : "Allowed"}</span> immediately before signing ({fullTimestamp(v.policy.at)})
              <ol className="mt-1 space-y-0.5 text-2xs">
                {v.policy.checks.map((c) => (
                  <li key={c.step} className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2">
                    <span className="mono text-fg-3">{c.step}</span>
                    <span>{c.label}</span>
                    <span className={c.status === "pass" ? "text-green" : c.status === "fail" ? "text-coral" : "text-fg-3"}>{c.status}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            "No pre-signing evaluation recorded."
          )}
        </Row>
        <Row n={8} step={step("approval")}>
          {v.approval.required ? (
            <>
              Owner {v.approval.outcome ?? "has not answered"}
              {v.approval.at && <> at {fullTimestamp(v.approval.at)}</>} · terms fingerprint <Mono title={v.approval.termsHash ?? undefined}>{v.approval.termsHash?.slice(0, 12)}…</Mono>
            </>
          ) : (
            "Within the approval threshold: no owner approval was required."
          )}
        </Row>
        <Row n={9} step={step("transaction")}>
          {v.payment?.txHash ? (
            <>
              <a href={v.payment.explorerUrl!} target="_blank" rel="noreferrer" className="mono inline-flex items-start gap-1 break-all text-cyan hover:underline">
                {v.payment.txHash} <ArrowUpRight className="mt-0.5 size-3 shrink-0" aria-hidden />
              </a>
              <p className="text-2xs text-fg-3">
                {v.payment.ledger ? `Confirmed on Horizon in ledger ${v.payment.ledger.toLocaleString("en-NG")}. ` : ""}
                {v.payment.amountUsdc} test USDC from <Mono title={v.payment.payer ?? undefined}>{v.payment.payer ? shortAddress(v.payment.payer) : "—"}</Mono> to <Mono title={v.payment.payTo ?? undefined}>{v.payment.payTo ? shortAddress(v.payment.payTo) : "—"}</Mono>.
              </p>
            </>
          ) : (
            "No transaction: nothing was paid."
          )}
        </Row>
        <Row n={10} step={step("released")}>
          {v.released?.type === "report" && isDiagnosticReport(v.released.report) ? (
            <DiagnosticReport report={v.released.report} compact />
          ) : v.released ? (
            <>
              {quantity(v.released.quantity ?? 0, v.released.unit ?? "")} released
              {v.released.balanceBefore !== null && (
                <>
                  {" "}
                  · device {quantity(v.released.balanceBefore, v.released.unit ?? "")} → {quantity(v.released.balanceAfter ?? 0, v.released.unit ?? "")}
                </>
              )}
              {v.released.demoToken && (
                <>
                  {" "}
                  · demo token <Mono>{v.released.demoToken}</Mono>
                </>
              )}
            </>
          ) : (
            "Nothing was released."
          )}
        </Row>
        <Row n={11} step={step("next")}>
          {v.next.items.length ? (
            <ul className="space-y-1">
              {v.next.items.map((i, k) => (
                <li key={k}>
                  <span className="text-fg">{i.title}</span>
                  {i.detail && <span className="block truncate text-2xs text-fg-3">{i.detail}</span>}
                </li>
              ))}
            </ul>
          ) : v.purchase.initiatedBy === "agent" ? (
            "No later agent step recorded yet."
          ) : (
            "Bought by the owner, not the agent."
          )}
        </Row>
      </ol>
      <UnpaidProbe purchaseId={v.purchase.id} />
    </div>
  );
}
