import Link from "next/link";
import { dayTime, naira, UTILITY_NAMES } from "@/lib/format";
import { FULFILMENT_STATUS, PAYMENT_STATUS, STAGE } from "@/lib/status";
import { cn, StatusPill } from "@/components/ui/primitives";
import type { DecisionView } from "@/server/views/household";

/** Line kinds are labelled in words, so facts, observations and predictions are never confused. */
const KIND_STYLE: Record<string, { label: string; cls: string }> = {
  fact: { label: "Fact", cls: "text-fg-2 border-line" },
  observation: { label: "Observed", cls: "text-cyan border-cyan/25" },
  prediction: { label: "Predicted", cls: "text-amber border-amber/25" },
  decision: { label: "Decision", cls: "text-green border-green/30" },
  constraint: { label: "Held back", cls: "text-coral border-coral/30" },
};

const OUTCOME: Record<string, { label: string; tone: "positive" | "warning" | "critical" | "neutral" | "info" }> = {
  purchase_started: { label: "Purchasing", tone: "positive" },
  awaiting_approval: { label: "Needs approval", tone: "warning" },
  blocked: { label: "Blocked", tone: "critical" },
  flagged: { label: "Flagged for review", tone: "warning" },
  no_action: { label: "No action needed", tone: "neutral" },
};

export function DecisionEntry({ d, compact = false }: { d: DecisionView; compact?: boolean }) {
  const outcome = OUTCOME[d.outcome] ?? { label: d.outcome, tone: "neutral" as const };
  const lines = compact ? d.lines.filter((l) => l.kind !== "fact" || l.utility === null).slice(0, 6) : d.lines;
  return (
    <article className="animate-fade-in">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-fg">{d.headline}</h3>
          <p className="mt-0.5 text-2xs text-fg-3">
            Assessed {dayTime(d.simTime)} (household time), {d.trigger === "tick" ? "after simulated usage" : d.trigger === "scenario" ? "demo scenario" : "run on request"}
          </p>
        </div>
        <StatusPill tone={outcome.tone} pulse={false}>
          {outcome.label}
        </StatusPill>
      </header>

      <ol className="mt-3 space-y-2">
        {lines.map((l, i) => {
          const k = KIND_STYLE[l.kind] ?? KIND_STYLE.fact!;
          return (
            <li key={i} className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-3 text-[13px] leading-relaxed">
              <span className={cn("justify-self-start rounded-sm border px-1.5 py-px text-2xs font-semibold", k.cls)}>{k.label}</span>
              <span className={cn(l.kind === "decision" || l.kind === "constraint" ? "text-fg" : "text-fg-2")}>{l.text}</span>
            </li>
          );
        })}
      </ol>

      {d.purchases.length > 0 && (
        <ul className="mt-4 space-y-2">
          {d.purchases.map((p) => {
            const stage = STAGE[p.stage]!;
            const pay = PAYMENT_STATUS[p.paymentStatus]!;
            const ful = FULFILMENT_STATUS[p.fulfilmentStatus]!;
            return (
              <li key={p.id}>
                <Link href={`/transactions/${p.id}`} className="flex flex-wrap items-center gap-2 rounded-md border border-line-soft bg-bg-2 px-3 py-2 text-[13px] hover:border-line">
                  <span className="font-semibold">{UTILITY_NAMES[p.kind]}</span>
                  <span className="mono text-fg-2">{naira(p.amountNgn)}</span>
                  <span className="ml-auto flex flex-wrap gap-1.5">
                    {p.stage === "awaiting_approval" || p.stage === "cancelled" ? (
                      <StatusPill tone={stage.tone}>{stage.label}</StatusPill>
                    ) : (
                      <>
                        <StatusPill tone={pay.tone} title={pay.hint}>{pay.label}</StatusPill>
                        <StatusPill tone={ful.tone} title={ful.hint}>{ful.label}</StatusPill>
                      </>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {!compact && d.budgetImpact.plannedNgn > 0 && (
        <p className="mt-3 text-2xs text-fg-3">
          Budget impact: {naira(d.budgetImpact.remainingBeforeNgn)} before, {naira(d.budgetImpact.plannedNgn)} committed, {naira(d.budgetImpact.remainingAfterNgn)} after.
        </p>
      )}
    </article>
  );
}
