"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, CircleAlert, ExternalLink, Radio, ShieldCheck, TimerOff } from "lucide-react";
import { Button, cn, Spinner, StatusPill, TestnetTag } from "@/components/ui/primitives";
import { useApiAction } from "@/components/ui/interactive";
import { naira, shortHash, UTILITY_NAMES } from "@/lib/format";
import { FULFILMENT_STATUS, PAYMENT_STATUS, STAGE, type Tone } from "@/lib/status";
import type { RunEventDTO, RunPurchaseView, RunView } from "@/server/views/runs";

// ── Stages ──────────────────────────────────────────────────────────────────

const STAGES: { key: string; label: string }[] = [
  { key: "planning", label: "Planning" },
  { key: "observing", label: "Observing" },
  { key: "analysing", label: "Analysing" },
  { key: "discovering", label: "Discovering" },
  { key: "comparing", label: "Comparing" },
  { key: "deciding", label: "Deciding" },
  { key: "checking_policy", label: "Policy check" },
  { key: "awaiting_approval", label: "Approval" },
  { key: "requesting_payment", label: "HTTP 402" },
  { key: "signing", label: "Signing" },
  { key: "settling", label: "Settling" },
  { key: "verifying_fulfilment", label: "Verifying" },
  { key: "updating_household", label: "Household updated" },
  { key: "reassessing", label: "Reassessing" },
  { key: "finished", label: "Finished" },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

/** The brief's sections: every event belongs to one, shown as a coloured label. */
const PHASE: Record<string, { label: string; cls: string }> = {
  planning: { label: "Plan", cls: "text-fg-2 border-line" },
  observing: { label: "Observe", cls: "text-cyan border-cyan/25" },
  analysing: { label: "Forecast", cls: "text-cyan border-cyan/25" },
  discovering: { label: "Discovery", cls: "text-fg-2 border-line" },
  comparing: { label: "Discovery", cls: "text-fg-2 border-line" },
  deciding: { label: "Decision", cls: "text-green border-green/30" },
  checking_policy: { label: "Policy", cls: "text-amber border-amber/25" },
  awaiting_approval: { label: "Approval", cls: "text-amber border-amber/25" },
  requesting_payment: { label: "Payment", cls: "text-cyan border-cyan/25" },
  signing: { label: "Payment", cls: "text-cyan border-cyan/25" },
  settling: { label: "Payment", cls: "text-cyan border-cyan/25" },
  verifying_fulfilment: { label: "Fulfilment", cls: "text-green border-green/30" },
  updating_household: { label: "Fulfilment", cls: "text-green border-green/30" },
  reassessing: { label: "Reassess", cls: "text-fg-2 border-line" },
  finished: { label: "Result", cls: "text-fg-2 border-line" },
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
      <pre tabIndex={0} aria-label={label} className="mono max-h-72 focus-visible:outline-2 focus-visible:outline-green overflow-auto rounded-sm bg-bg p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2">{JSON.stringify(value, null, 2)}</pre>
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
      case "payment.failed":
        items.push({ ...base, title: e.paymentStatus === "failed" ? "Payment stopped — not charged" : "Payment outcome unknown", body: e.reason, tone: "critical" });
        break;
      default:
        if (e.type.startsWith("purchase.")) {
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
    <ol className="flex flex-wrap gap-1.5" aria-label="Run stages">
      {STAGES.map((s) => {
        const state = s.key === current ? "current" : reached.has(s.key) ? "done" : running ? "pending" : "skipped";
        return (
          <li
            key={s.key}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-sm border px-2 text-2xs font-semibold",
              state === "done" && "border-green/30 bg-green-soft text-green",
              state === "current" && "border-cyan/40 bg-cyan/10 text-cyan",
              state === "pending" && "border-line text-fg-3",
              state === "skipped" && "border-dashed border-line text-fg-3",
            )}
            title={state === "skipped" ? "Not needed in this run" : undefined}
          >
            {state === "done" && <Check className="size-3" aria-hidden />}
            {state === "current" && <Spinner className="size-3" />}
            {s.label}
            <span className="sr-only">{` (${state})`}</span>
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
    <section aria-label="Approval request" className={cn("rounded-lg border px-4 py-3", expired ? "border-line bg-bg-2" : "border-amber/30 bg-amber-soft")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {expired ? <TimerOff className="size-5 shrink-0 text-fg-3" aria-hidden /> : <ShieldCheck className="size-5 shrink-0 text-amber" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-fg">
            Approve {p.label} from {p.providerName}
            {p.label.includes("₦") ? null : <> for <span className="mono">{naira(p.amountNgn)}</span></>}?
          </p>
          <p className="text-[13px] text-fg-2" aria-live="polite">
            {expired ? "This request expired. Nothing was paid." : <>It&apos;s above your approval threshold. Nothing is paid unless you approve. Expires in <span className="mono">{mmss}</span>.</>}
          </p>
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
              run<{ stage: string }>(`/api/purchases/${p.id}/approve`, {}, {
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
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-line-soft bg-bg-2 px-3 py-2 text-[13px]">
      <Link href={`/transactions/${p.id}`} className="font-semibold hover:underline">
        {p.label}
      </Link>
      <span className="text-fg-3">{p.providerName}</span>
      <span className="mono text-fg-2">{naira(p.amountNgn)}</span>
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
    <div className="space-y-6">
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-2xs font-semibold tracking-wide text-fg-3 uppercase">Task</p>
            <p className="mt-1 text-[15px] text-fg">{r.task}</p>
            <p className="mt-2 text-2xs text-fg-3">
              {r.mode === "ai" ? `AI agent · ${r.model}` : "Deterministic planner (no AI)"} · started {time(r.startedAt)}
              {r.endedAt ? ` · ended ${time(r.endedAt)}` : ""} · {events.length} events
              {r.usage?.prompt_tokens ? ` · ${r.usage.prompt_tokens.toLocaleString()} / ${r.usage.completion_tokens?.toLocaleString()} tokens` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {running && (
              <span className={cn("inline-flex items-center gap-1 text-2xs font-semibold", live ? "text-cyan" : "text-fg-3")} aria-live="polite">
                <Radio className="size-3.5" aria-hidden /> {live ? "Live" : "Connecting…"}
              </span>
            )}
            <StatusPill tone={st.tone} pulse={running}>
              {st.label}
            </StatusPill>
            <TestnetTag />
          </div>
        </div>
        <div className="mt-4">
          <StageStepper events={events} running={running} />
        </div>
        {!running && r.summary && (
          <div className={cn("mt-4 rounded-md border p-3 text-[13px]", status === "completed" ? "border-line-soft bg-bg-2 text-fg" : "border-coral/30 bg-coral-soft text-fg")}>
            {status !== "completed" && <CircleAlert className="mr-1.5 inline size-4 text-coral" aria-hidden />}
            {r.summary}
          </div>
        )}
      </section>

      {awaiting.map((p) => (
        <ApprovalCard key={p.id} p={p} />
      ))}

      {view.purchases.length > 0 && (
        <section aria-labelledby="run-purchases">
          <h2 id="run-purchases" className="mb-2 text-sm font-semibold text-fg-2">
            Purchases in this run
          </h2>
          <ul className="space-y-2">
            {view.purchases.map((p) => (
              <PurchaseRow key={p.id} p={p} explorer={view.explorerTxBase} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="run-timeline" className="rounded-lg border border-line bg-surface">
        <header className="flex items-center justify-between border-b border-line-soft px-5 py-3">
          <h2 id="run-timeline" className="text-sm font-semibold">
            Execution timeline
          </h2>
          <p className="text-2xs text-fg-3">Every entry is a persisted backend event · times in WAT</p>
        </header>
        <ol className="divide-y divide-line-soft" aria-live="polite" aria-relevant="additions">
          {items.map((it) => {
            const phase = PHASE[it.stage] ?? PHASE.planning!;
            return (
              <li key={it.key} className="px-5 py-3" data-stage={it.stage}>
                <div className="grid grid-cols-[64px_84px_minmax(0,1fr)] items-baseline gap-3 max-sm:grid-cols-[84px_minmax(0,1fr)]">
                  <span className="mono text-2xs text-fg-3 max-sm:hidden">{time(it.at)}</span>
                  <span className={cn("justify-self-start rounded-sm border px-1.5 py-px text-2xs font-semibold", phase.cls)} title={STAGE_LABEL[it.stage]}>
                    {phase.label}
                  </span>
                  <div className="min-w-0">
                    <p className={cn("flex items-center gap-1.5 text-[13px] font-semibold", it.tone === "critical" ? "text-coral" : it.tone === "warning" ? "text-amber" : "text-fg")}>
                      {it.pending && <Spinner className="size-3" />}
                      {it.title}
                    </p>
                    {it.body && <p className="mt-0.5 text-[13px] leading-relaxed break-words text-fg-2">{it.body}</p>}
                    {it.txHash && (
                      <a href={`${view.explorerTxBase}/${it.txHash}`} target="_blank" rel="noreferrer" className="mono mt-1 inline-flex items-center gap-1 text-2xs text-cyan hover:underline">
                        Stellar tx {shortHash(it.txHash, 8)} <ExternalLink className="size-3" aria-hidden />
                        <span className="sr-only">(opens Stellar Expert)</span>
                      </a>
                    )}
                    {it.details && (
                      <details className="group mt-1.5">
                        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-2xs font-medium text-fg-3 hover:text-fg">
                          <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
                          Details
                        </summary>
                        <div className="mt-2 w-0 min-w-full space-y-2 rounded-md border border-line-soft bg-bg-2 p-3 text-2xs">{it.details}</div>
                      </details>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
          {running && (
            <li className="flex items-center gap-2 px-5 py-3 text-[13px] text-fg-3">
              <Spinner className="size-3.5" /> Waiting for the next step…
            </li>
          )}
        </ol>
      </section>
    </div>
  );
}
