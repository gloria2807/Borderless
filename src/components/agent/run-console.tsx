"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, CircleAlert, ExternalLink, ShieldCheck, TimerOff } from "lucide-react";
import { Button, cn, LiveChip, Spinner, StatusPill, TestnetTag } from "@/components/ui/primitives";
import { useApiAction } from "@/components/ui/interactive";
import { atomicToDecimal, naira, shortAddress, shortHash, UTILITY_NAMES } from "@/lib/format";
import { FULFILMENT_STATUS, PAYMENT_STATUS, STAGE, type Tone } from "@/lib/status";
import type { RunEventDTO, RunPurchaseView, RunView } from "@/server/views/runs";
import { DiagnosticReport, isDiagnosticReport } from "./diagnostic-report";

// ── Stages ──────────────────────────────────────────────────────────────────

const STAGES: { key: string; label: string }[] = [
  { key: "planning", label: "Planning" },
  { key: "observing", label: "Observing" },
  { key: "analysing", label: "Analysing" },
  { key: "identifying_need", label: "Identifying a need" },
  { key: "discovering", label: "Discovering" },
  { key: "comparing", label: "Evaluating" },
  { key: "deciding", label: "Deciding" },
  { key: "checking_policy", label: "Authorising" },
  { key: "awaiting_approval", label: "Approval" },
  { key: "requesting_payment", label: "Requesting (HTTP 402)" },
  { key: "signing", label: "Paying · signing" },
  { key: "settling", label: "Paying · settling" },
  { key: "verifying_fulfilment", label: "Receiving the service" },
  { key: "updating_household", label: "Household updated" },
  { key: "using_result", label: "Acting on the result" },
  { key: "reassessing", label: "Reassessing" },
  { key: "finished", label: "Finished" },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

/** The brief's sections: every event belongs to one, shown as a coloured label. */
const PHASE: Record<string, { label: string; cls: string }> = {
  planning: { label: "Plan", cls: "text-fg-2 bg-fg/[0.06]" },
  observing: { label: "Observe", cls: "text-cyan bg-cyan-soft" },
  analysing: { label: "Forecast", cls: "text-cyan bg-cyan-soft" },
  identifying_need: { label: "Need", cls: "text-amber bg-amber-soft" },
  discovering: { label: "Discovery", cls: "text-fg-2 bg-fg/[0.06]" },
  comparing: { label: "Evaluate", cls: "text-fg-2 bg-fg/[0.06]" },
  deciding: { label: "Decision", cls: "text-green bg-green-soft" },
  checking_policy: { label: "Authorise", cls: "text-amber bg-amber-soft" },
  awaiting_approval: { label: "Approval", cls: "text-amber bg-amber-soft" },
  requesting_payment: { label: "Payment", cls: "text-cyan bg-cyan-soft" },
  signing: { label: "Payment", cls: "text-cyan bg-cyan-soft" },
  settling: { label: "Payment", cls: "text-cyan bg-cyan-soft" },
  verifying_fulfilment: { label: "Fulfilment", cls: "text-green bg-green-soft" },
  updating_household: { label: "Fulfilment", cls: "text-green bg-green-soft" },
  using_result: { label: "Using result", cls: "text-green bg-green-soft" },
  reassessing: { label: "Reassess", cls: "text-fg-2 bg-fg/[0.06]" },
  finished: { label: "Result", cls: "text-fg-2 bg-fg/[0.06]" },
};

const TOOL_LABEL: Record<string, string> = {
  observe_household: "Observed the household",
  inspect_utility: "Analysed a utility",
  inspect_budget: "Checked the budget",
  discover_providers: "Discovered providers",
  compare_offers: "Compared offers",
  get_allocation_recommendation: "Asked the allocation engine",
  request_quote: "Requested a quote",
  propose_purchase: "Dry-ran the spending rules",
  discover_information_services: "Discovered information services",
  buy_information: "Bought information",
  purchase_utility: "Purchase requested",
  inspect_transaction: "Inspected the transaction",
  verify_fulfilment: "Verified fulfilment",
  reassess_household: "Reassessed the household",
  finish: "Finished",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Africa/Lagos" });
const hrs = (v: unknown) => (typeof v === "number" ? (v >= 48 ? `${Math.round(v / 24)} days` : `${Math.round(v)} h`) : "—");
const utility = (u: unknown) => (typeof u === "string" && u in UTILITY_NAMES ? UTILITY_NAMES[u as keyof typeof UTILITY_NAMES] : String(u ?? ""));

/** One-line, evidence-only summary of a tool result. */
function toolSummary(tool: string, r: Obj): string | null {
  if (typeof r.error === "string") return r.error;
  switch (tool) {
    case "observe_household":
      return arr(r.utilities).map((u) => `${utility(u.utility)} ${hrs(u.hours_of_service_left)} left`).join(" · ") + (obj(r.budget).remaining_ngn !== undefined ? ` · budget ${naira(Number(obj(r.budget).remaining_ngn))} left` : "");
    case "inspect_utility":
      return `${utility(r.utility)}: ${r.balance} ${r.unit}, about ${hrs(r.hours_of_service_left)} left, forecast confidence ${r.forecast_confidence}`;
    case "inspect_budget":
      return `${naira(Number(r.household_budget_remaining_ngn ?? 0))} left in the budget; this run has spent ${naira(Number(r.spent_by_this_run_ngn ?? 0))}`;
    case "discover_providers":
      return arr(r.providers).map((p) => `${p.name}${p.available ? "" : " (unavailable)"}`).join(", ");
    case "compare_offers":
      return `${arr(r.offers).length} offers compared for ${utility(r.utility)}`;
    case "get_allocation_recommendation": {
      const rec = arr(r.recommended);
      return rec.length ? `Recommends ${rec.map((x) => `${x.label} (${utility(x.utility)})`).join(" and ")}` : "Recommends no purchase now";
    }
    case "request_quote":
      return `${r.provider ?? r.provider_id}: ${r.product}, ${naira(Number(r.price_ngn))} = ${r.testnet_usdc} test USDC, valid until ${typeof r.expires_at === "string" ? time(r.expires_at) : "—"}`;
    case "propose_purchase":
      return `${String(r.outcome)}${r.needed === false ? " — not needed now" : ""}`;
    case "purchase_utility":
      return r.status === "completed" ? `Paid and delivered${r.balance_after ? ` — balance now ${r.balance_after}` : ""}` : `${String(r.status).replace(/_/g, " ")}${r.reason ? `: ${r.reason}` : r.failure ? `: ${r.failure}` : ""}`;
    case "verify_fulfilment":
      return r.verified ? `Verified: device balance ${r.device_balance_now}` : `Not verified (${r.provider_reports})`;
    case "reassess_household":
      return arr(r.utilities).map((u) => `${utility(u.utility)} ${hrs(u.hours_of_service_left)}`).join(" · ");
    case "discover_information_services":
      return arr(r.services).map((x) => `${x.name} ${naira(Number(x.price_ngn ?? 0))}${x.verified ? "" : " (unverified)"}`).join(" · ") || "No information services found";
    case "buy_information":
      return r.status === "completed" ? `Paid; report released: ${String(obj(r.report).summary ?? "")}` : `${String(r.status).replace(/_/g, " ")}${r.reason ? `: ${r.reason}` : r.failure ? `: ${r.failure}` : ""}`;
    case "finish":
      return null;
    default:
      return null;
  }
}

interface Item {
  key: string;
  at: string;
  stage: string;
  title: string;
  body: string | null;
  tone: Tone;
  pending?: boolean;
  details?: ReactNode;
  txHash?: string | null;
  purchaseId?: string | null;
}

function PolicyChecks({ checks }: { checks: Obj[] }) {
  return (
    <ol className="space-y-1">
      {checks.map((c) => (
        <li key={String(c.step)} className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-baseline gap-2">
          <span className="mono text-fg-3">{String(c.step)}</span>
          <span>
            <span className="text-fg">{String(c.label)}</span>
            {c.detail ? <span className="block text-fg-3">{String(c.detail)}</span> : null}
          </span>
          <span className={cn("font-semibold", c.status === "pass" ? "text-green" : c.status === "fail" ? "text-coral" : c.status === "approval" ? "text-amber" : "text-fg-3")}>{String(c.status)}</span>
        </li>
      ))}
    </ol>
  );
}

function Raw({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <p className="mb-1 font-medium text-fg-2">{label}</p>
      <pre tabIndex={0} aria-label={label} className="mono max-h-72 overflow-auto rounded-md bg-raised p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2 shadow-ring focus-visible:outline-2 focus-visible:outline-green">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/** Turn the raw log into readable items. Tool calls are merged with their results. */
function buildItems(events: RunEventDTO[]): Item[] {
  const items: Item[] = [];
  const openCalls = new Map<string, { item: Item; input: unknown }>();
  for (const e of events) {
    const base = { key: e.id, at: e.at, stage: e.stage, txHash: e.txHash, purchaseId: e.purchaseId };
    const result = obj(e.result);
    switch (e.type) {
      case "tool.called": {
        const item: Item = { ...base, title: TOOL_LABEL[e.tool ?? ""] ?? e.tool ?? "Tool", body: null, tone: "progress", pending: true, details: <Raw label="Arguments" value={e.input} /> };
        items.push(item);
        openCalls.set(e.tool ?? "", { item, input: e.input });
        break;
      }
      case "tool.result": {
        const open = openCalls.get(e.tool ?? "");
        const item = open?.item ?? { ...base, title: TOOL_LABEL[e.tool ?? ""] ?? "Tool", body: null, tone: "neutral" as Tone };
        openCalls.delete(e.tool ?? "");
        item.pending = false;
        item.body = toolSummary(e.tool ?? "", result);
        item.tone = typeof result.error === "string" || result.status === "refused" ? "warning" : "neutral";
        item.details = (
          <>
            <Raw label="Arguments" value={open?.input} />
            <Raw label="Result (data the agent received)" value={e.result} />
          </>
        );
        if (!open) items.push(item);
        break;
      }
      case "tool.rejected":
      case "tool.error":
        items.push({ ...base, title: e.type === "tool.rejected" ? `Rejected a call to ${e.tool}` : `${e.tool} failed`, body: e.reason ?? e.error, tone: "critical", details: <Raw label="Arguments" value={e.input} /> });
        break;
      case "model.message":
        items.push({ ...base, title: "Agent", body: e.reason, tone: "info" });
        break;
      case "policy.evaluated": {
        const checks = arr(result.checks);
        const http = obj(result.http_402);
        const dry = result.dry_run === true;
        const outcome = e.decision === "deny" ? "refused" : e.decision === "require_approval" ? "needs approval" : "allowed";
        items.push({
          ...base,
          title: `${dry ? "Dry run: spending rules" : "Spending rules"} — ${outcome}`,
          body: http.amount_usdc ? `HTTP 402 asked for ${http.amount_usdc} test USDC to ${shortHash(String(http.pay_to), 6)} on ${http.network}. ${e.reason ?? ""}` : e.reason,
          tone: e.decision === "deny" ? "critical" : e.decision === "require_approval" ? "warning" : "positive",
          details: checks.length ? <PolicyChecks checks={checks} /> : undefined,
        });
        break;
      }
      case "planner.decision":
        items.push({ ...base, title: "Decision (allocation engine)", body: e.reason, tone: "positive", details: <Raw label="Options and budget" value={e.result} /> });
        break;
      case "need.identified":
        items.push({ ...base, title: `Need identified: ${utility(e.utility)}`, body: e.reason, tone: "warning" });
        break;
      case "planner.reassessed":
        items.push({ ...base, title: "Acting on the result", body: e.reason, tone: "info" });
        break;
      case "planner.adapted":
        items.push({ ...base, title: e.decision === "try_alternative" ? "Adapted: trying another provider" : "Adapted: no alternative", body: e.reason, tone: "warning" });
        break;
      case "purchase.proposed":
        items.push({ ...base, title: `Proposed ${utility(e.utility).toLowerCase()} purchase`, body: e.reason, tone: "positive", details: <Raw label="Proposal" value={e.input} /> });
        break;
      case "purchase.not_needed":
      case "purchase.refused":
        items.push({ ...base, title: e.type === "purchase.not_needed" ? "Purchase not needed" : "Purchase refused", body: e.reason, tone: "warning" });
        break;
      case "approval.requested":
      case "approval.granted":
      case "approval.declined":
      case "approval.expired":
        items.push({ ...base, title: { "approval.requested": "Waiting for owner approval", "approval.granted": "Owner approved", "approval.declined": "Owner declined", "approval.expired": "Approval request expired" }[e.type]!, body: e.reason, tone: e.type === "approval.granted" ? "positive" : "warning" });
        break;
      case "payment.requesting_payment":
      case "payment.signing":
      case "payment.settling":
      case "payment.verifying_fulfilment":
        items.push({ ...base, title: { "payment.requesting_payment": "Requested the purchase (expecting HTTP 402)", "payment.signing": "Signing the payment", "payment.settling": "Settling on Stellar testnet", "payment.verifying_fulfilment": "Settled — confirming and verifying" }[e.type]!, body: e.reason, tone: "progress" });
        break;
      case "funding.topped_up":
      case "funding.refused":
        items.push({ ...base, title: e.type === "funding.topped_up" ? "Funding guard: wallet topped up from the treasury" : "Funding guard: top-up refused", body: e.reason, tone: e.type === "funding.topped_up" ? "info" : "warning" });
        break;
      case "payment.failed":
        items.push({ ...base, title: e.paymentStatus === "failed" ? "Payment stopped — not charged" : "Payment outcome unknown", body: e.reason, tone: "critical" });
        break;
      default:
        if (e.type === "purchase.completed" && isDiagnosticReport(result.report)) {
          items.push({
            ...base,
            title: "Diagnostic report received",
            body: (result.report as { summary?: string }).summary ?? null,
            tone: "positive",
            details: <DiagnosticReport report={result.report} />,
          });
        } else if (e.type.startsWith("purchase.")) {
          const done = e.type === "purchase.completed";
          items.push({
            ...base,
            title: done ? `${utility(e.utility)} delivered` : `Purchase ${String(e.decision ?? e.type.slice(9)).replace(/_/g, " ")}`,
            body: done ? `Balance ${result.balance_before ?? "?"} → ${result.balance_after ?? "?"} ${result.unit ?? ""}${result.demo_token ? ` · demo token ${result.demo_token}` : ""}` : e.reason,
            tone: done ? "positive" : "critical",
            details: <Raw label="Outcome" value={e.result} />,
          });
        } else if (e.type.startsWith("run.") || e.type.startsWith("model.")) {
          const ok = e.type === "run.completed" || e.type === "run.started";
          items.push({ ...base, title: { "run.started": "Run started", "run.completed": "Run completed", "run.failed": "Run failed", "run.interrupted": "Run interrupted", "run.error": "Internal error", "model.error": "AI model error" }[e.type] ?? e.type, body: e.reason ?? e.error, tone: ok ? "neutral" : "critical", details: e.type === "run.completed" ? <Raw label="Result" value={e.result} /> : <Raw label="Input" value={e.input} /> });
        } else {
          items.push({ ...base, title: e.type, body: e.reason, tone: "neutral" });
        }
    }
  }
  return items;
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function StageStepper({ events, running }: { events: RunEventDTO[]; running: boolean }) {
  // A purchase tool call is filed under requesting_payment, but no HTTP 402 has happened until
  // the buyer reports it: payment stages count only from real payment/policy events.
  const reached = new Set<string>(events.filter((e) => !(e.type.startsWith("tool.") && e.stage === "requesting_payment")).map((e) => e.stage));
  const current = running ? events.at(-1)?.stage : undefined;
  return (
    <ol className="relative" aria-label="Run stages">
      {STAGES.map((s, i) => {
        const state = s.key === current ? "current" : reached.has(s.key) ? "done" : running ? "pending" : "skipped";
        const last = i === STAGES.length - 1;
        return (
          <li
            key={s.key}
            aria-current={state === "current" ? "step" : undefined}
            className="relative grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 py-[5px]"
            title={state === "skipped" ? "Not needed in this run" : undefined}
          >
            {!last && <span aria-hidden className={cn("absolute top-[19px] left-[8.5px] h-[calc(100%-8px)] w-px", state === "done" ? "bg-green/40" : "bg-fg/[0.08]")} />}
            <span
              aria-hidden
              className={cn(
                "relative z-10 flex size-[18px] items-center justify-center rounded-full",
                state === "done" && "bg-green text-white",
                state === "current" && "bg-surface text-cyan shadow-[0_0_0_1.5px_var(--color-cyan)]",
                state === "pending" && "bg-surface shadow-[inset_0_0_0_1.5px_rgb(12_13_12/0.14)]",
                state === "skipped" && "bg-transparent",
              )}
            >
              {state === "done" && <Check className="size-[11px]" strokeWidth={3} />}
              {state === "current" && <span className="size-1.5 animate-pulse-dot rounded-full bg-cyan" />}
              {state === "skipped" && <span className="size-1 rounded-full bg-fg/20" />}
            </span>
            <span
              className={cn(
                "text-[12.5px]",
                state === "done" && "text-fg",
                state === "current" && "font-semibold text-cyan",
                state === "pending" && "text-fg-3",
                state === "skipped" && "text-fg-3 line-through decoration-fg/20",
              )}
            >
              {s.label}
              <span className="sr-only">{` (${state === "skipped" ? "not needed in this run" : state})`}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function useCountdown(deadline: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : null;
}

/** The exact payment the owner is approving, and the fingerprint of those terms. */
export function ApprovalTermsLine({ t, hash }: { t: { amountAtomic: string; payTo: string; recipient: string }; hash: string | null }) {
  return (
    <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-3">
      Pays exactly <span className="mono text-fg-2">{atomicToDecimal(t.amountAtomic)} test USDC</span> to <span className="mono text-fg-2" title={t.payTo}>{shortAddress(t.payTo)}</span> for{" "}
      <span className="mono text-fg-2">{t.recipient}</span>
      {hash && (
        <>
          {" "}· terms <span className="mono" title={hash}>{hash.slice(0, 8)}</span>
        </>
      )}
      . Anything different is refused before signing.
    </p>
  );
}

export function ApprovalCard({ p }: { p: RunPurchaseView }) {
  const { run, pending } = useApiAction();
  const left = useCountdown(p.approvalExpiresAt);
  const expired = left === 0;
  const router = useRouter();
  const refreshed = useRef(false);
  useEffect(() => {
    if (expired && !refreshed.current) {
      refreshed.current = true;
      router.refresh(); // the server closes the request; the card then shows it as expired
    }
  }, [expired, router]);
  const mmss = left === null ? null : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <section aria-label="Approval request" className="relative overflow-hidden rounded-lg bg-surface py-3.5 pr-4 pl-5 shadow-ring">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", expired ? "bg-fg/15" : "bg-amber")} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", expired ? "bg-fg/[0.06]" : "bg-amber-soft")}>
          {expired ? <TimerOff className="size-4 text-fg-3" aria-hidden /> : <ShieldCheck className="size-4 text-amber" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("label mb-1", !expired && "text-amber")}>{expired ? "Approval expired" : "Approval requested"}</p>
          <p className="text-[13.5px] font-semibold text-fg">
            Approve {p.label} from {p.providerName}
            {p.label.includes("₦") ? null : <> for <span className="mono">{naira(p.amountNgn)}</span></>}?
          </p>
          <p className="text-[12.5px] text-fg-2" aria-live="polite">
            {expired ? "This request expired. Nothing was paid." : <>It&apos;s above your approval threshold. Nothing is paid unless you approve. Expires in <span className="mono rounded bg-amber-soft px-1 text-amber">{mmss}</span>.</>}
          </p>
          {p.approvalTerms && !expired && <ApprovalTermsLine t={p.approvalTerms} hash={p.approvalTermsHash} />}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={pending || expired} onClick={() => run(`/api/purchases/${p.id}/decline`, {}, { success: () => ({ title: "Purchase declined", body: "Nothing was paid." }), errorTitle: "Couldn't decline" })}>
            Decline
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={pending}
            disabled={expired}
            onClick={() =>
              run<{ stage: string }>(`/api/purchases/${p.id}/approve`, { body: { termsHash: p.approvalTermsHash ?? undefined } }, {
                success: (d) => (d.stage === "completed" ? { title: "Approved and paid", body: `${UTILITY_NAMES[p.kind]} delivered to the virtual device.` } : { title: "Approved", body: "See the timeline for the payment outcome." }),
                errorTitle: "Couldn't approve",
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

function PurchaseRow({ p, explorer }: { p: RunPurchaseView; explorer: string }) {
  const expired = p.failureCode === "approval_expired";
  const stage = expired ? { label: "Approval expired", tone: "neutral" as Tone } : (STAGE[p.stage] ?? { label: p.stage, tone: "neutral" as Tone });
  const pay = PAYMENT_STATUS[p.paymentStatus];
  const ful = FULFILMENT_STATUS[p.fulfilmentStatus];
  return (
    <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg bg-surface px-3.5 py-2.5 text-[13px] shadow-ring">
      <Link href={`/transactions/${p.id}`} className="font-medium hover:underline">
        {p.label}
      </Link>
      <Link href={`/transactions/${p.id}#procurement`} className="text-[11.5px] font-medium text-cyan hover:underline">
        Inspect procurement
      </Link>
      <span className="text-fg-3">{p.providerName}</span>
      <span className="text-fg-2 tabular">{naira(p.amountNgn)}</span>
      {p.txHash && (
        <a href={`${explorer}/${p.txHash}`} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1 text-2xs text-cyan hover:underline">
          {shortHash(p.txHash, 6)} <ExternalLink className="size-3" aria-hidden />
          <span className="sr-only">(opens Stellar Expert)</span>
        </a>
      )}
      <span className="ml-auto flex flex-wrap gap-1.5">
        {p.stage === "awaiting_approval" || p.stage === "cancelled" ? (
          <StatusPill tone={stage.tone} pulse={false}>{stage.label}</StatusPill>
        ) : (
          <>
            {pay && <StatusPill tone={pay.tone} title={pay.hint}>{pay.label}</StatusPill>}
            {ful && <StatusPill tone={ful.tone} title={ful.hint}>{ful.label}</StatusPill>}
          </>
        )}
      </span>
    </li>
  );
}

// ── Console ─────────────────────────────────────────────────────────────────

const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "progress" },
  completed: { label: "Completed", tone: "positive" },
  failed: { label: "Failed", tone: "critical" },
  interrupted: { label: "Interrupted", tone: "warning" },
};

export function RunConsole({ view }: { view: RunView }) {
  const router = useRouter();
  const [events, setEvents] = useState<RunEventDTO[]>(view.events);
  const [status, setStatus] = useState(view.run.status);
  const [live, setLive] = useState(false);
  const lastSeq = useRef(view.events.at(-1)?.seq ?? 0);

  // A server refresh (after an approval, say) brings newer persisted events: merge by seq.
  useEffect(() => {
    setEvents((cur) => {
      const seen = new Set(cur.map((e) => e.seq));
      const merged = [...cur, ...view.events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
      lastSeq.current = merged.at(-1)?.seq ?? 0;
      return merged;
    });
    setStatus(view.run.status);
  }, [view.events, view.run.status]);

  // Live stream while the run is going. Resumes after the last event we already have.
  useEffect(() => {
    if (view.run.status !== "running") return;
    const es = new EventSource(`/api/agent/runs/${view.run.id}/events?after=${lastSeq.current}`);
    es.onopen = () => setLive(true);
    es.addEventListener("run-event", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as RunEventDTO;
      lastSeq.current = Math.max(lastSeq.current, e.seq);
      setEvents((cur) => (cur.some((x) => x.seq === e.seq) ? cur : [...cur, e].sort((a, b) => a.seq - b.seq)));
    });
    es.addEventListener("end", (m) => {
      const { status: s } = JSON.parse((m as MessageEvent).data) as { status: RunView["run"]["status"] };
      setStatus(s);
      setLive(false);
      es.close();
      router.refresh(); // purchases, summary and approval cards from the server
    });
    es.onerror = () => setLive(false); // the browser reconnects with Last-Event-ID
    return () => es.close();
  }, [view.run.id, view.run.status, router]);

  const items = useMemo(() => buildItems(events), [events]);
  const running = status === "running";
  const st = RUN_STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  const awaiting = view.purchases.filter((p) => p.stage === "awaiting_approval");
  const r = view.run;

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-5">
        <section className="rounded-lg bg-surface p-4 shadow-ring">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="label">Task</p>
              <p className="mt-1.5 text-[15px] leading-snug tracking-[-0.01em] text-fg">{r.task}</p>
              <p className="mono mt-2 text-[10.5px] text-fg-3">
                {r.mode === "ai" ? `AI agent · ${r.model}` : "Deterministic planner (no AI)"} · started {time(r.startedAt)}
                {r.endedAt ? ` · ended ${time(r.endedAt)}` : ""} · {events.length} events
                {r.usage?.prompt_tokens ? ` · ${r.usage.prompt_tokens.toLocaleString()} / ${r.usage.completion_tokens?.toLocaleString()} tokens` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {running && (
                <span aria-live="polite">
                  <LiveChip live={live} tone="info">{live ? "Live" : "Connecting…"}</LiveChip>
                </span>
              )}
              <StatusPill tone={st.tone} pulse={running}>
                {st.label}
              </StatusPill>
              <TestnetTag />
            </div>
          </div>
          {!running && r.summary && (
            <div className={cn("mt-4 flex gap-2 rounded-lg p-3 text-[13px] leading-relaxed", status === "completed" ? "bg-green-soft/60 text-fg" : "bg-coral-soft text-fg")}>
              {status === "completed" ? <Check className="mt-0.5 size-4 shrink-0 text-green" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-coral" aria-hidden />}
              <span>{r.summary}</span>
            </div>
          )}
        </section>

        {awaiting.map((p) => (
          <ApprovalCard key={p.id} p={p} />
        ))}

        {view.purchases.length > 0 && (
          <section aria-labelledby="run-purchases">
            <h2 id="run-purchases" className="label mb-2.5">
              Purchases in this run
            </h2>
            <ul className="space-y-2">
              {view.purchases.map((p) => (
                <PurchaseRow key={p.id} p={p} explorer={view.explorerTxBase} />
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="run-timeline" className="rounded-lg bg-surface shadow-ring">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
            <h2 id="run-timeline" className="text-[13.5px] font-semibold">
              Execution timeline
            </h2>
            <p className="mono text-[10.5px] text-fg-3">Persisted backend events · WAT</p>
          </header>
          <ol className="divide-y divide-line-soft" aria-live="polite" aria-relevant="additions">
            {items.map((it) => {
              const phase = PHASE[it.stage] ?? PHASE.planning!;
              return (
                <li key={it.key} className="animate-fade-in px-4 py-3" data-stage={it.stage}>
                  <div className="grid grid-cols-[60px_88px_minmax(0,1fr)] items-baseline gap-3 max-sm:grid-cols-[88px_minmax(0,1fr)]">
                    <span className="mono text-[10.5px] text-fg-3 max-sm:hidden">{time(it.at)}</span>
                    <span className={cn("justify-self-start rounded-full px-2 py-px text-[10.5px] font-medium", phase.cls)} title={STAGE_LABEL[it.stage]}>
                      {phase.label}
                    </span>
                    <div className="min-w-0">
                      <p className={cn("flex items-center gap-1.5 text-[13px] font-medium", it.tone === "critical" ? "text-coral" : it.tone === "warning" ? "text-amber" : "text-fg")}>
                        {it.pending && <Spinner className="size-3" />}
                        {it.title}
                      </p>
                      {it.body && <p className="mt-0.5 text-[12.5px] leading-relaxed break-words text-fg-2">{it.body}</p>}
                      {it.txHash && (
                        <a href={`${view.explorerTxBase}/${it.txHash}`} target="_blank" rel="noreferrer" className="mono mt-1 inline-flex items-center gap-1 text-[11px] text-cyan hover:underline">
                          Stellar tx {shortHash(it.txHash, 8)} <ExternalLink className="size-3" aria-hidden />
                          <span className="sr-only">(opens Stellar Expert)</span>
                        </a>
                      )}
                      {it.details && (
                        <details className="group mt-1.5">
                          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11.5px] font-medium text-fg-3 hover:text-fg">
                            <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
                            Details
                          </summary>
                          <div className="mt-2 w-0 min-w-full space-y-2 rounded-lg bg-bg p-3 text-[11.5px] shadow-[inset_0_0_0_1px_rgb(12_13_12/0.06)]">{it.details}</div>
                        </details>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
            {running && (
              <li className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-fg-3">
                <Spinner className="size-3.5" /> Waiting for the next recorded step…
              </li>
            )}
          </ol>
        </section>
      </div>

      <aside className="rounded-lg bg-surface p-4 shadow-ring xl:sticky xl:top-6" aria-label="Progress">
        <p className="label mb-3">Stages</p>
        <StageStepper events={events} running={running} />
        <p className="mt-3 border-t border-line-soft pt-3 text-[11px] leading-relaxed text-fg-3">
          A stage lights up only when the server records it. Struck-through stages weren&apos;t needed in this run.
        </p>
      </aside>
    </div>
  );
}
