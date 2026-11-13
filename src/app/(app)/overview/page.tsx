import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ActivityTimeline } from "@/components/agent/activity-timeline";
import { ApprovalPrompt, AttentionPrompt, RunAgentButton } from "@/components/agent/actions";
import { DecisionEntry } from "@/components/agent/decision-entry";
import { BudgetPanel } from "@/components/overview/budget";
import { Runway } from "@/components/overview/runway";
import { UtilitySummary } from "@/components/overview/utility-summary";
import { cn, EmptyState, KpiStrip, Panel, SectionLabel } from "@/components/ui/primitives";
import { duration, durationLong, naira, UTILITY_NAMES } from "@/lib/format";
import type { Tone } from "@/lib/status";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { getEvents, getHouseholdOverview } from "@/server/views/household";

export const dynamic = "force-dynamic";

function statusLine(o: Awaited<ReturnType<typeof getHouseholdOverview>>): { tone: Tone; text: string } {
  const byUrgency = [...o.utilities].sort((a, b) => (a.forecast.hoursRemaining ?? Infinity) - (b.forecast.hoursRemaining ?? Infinity));
  const out = byUrgency.filter((u) => u.balance <= 0);
  const critical = byUrgency.filter((u) => u.forecast.urgency === "critical" && u.balance > 0);
  const low = byUrgency.filter((u) => u.forecast.urgency === "low");
  if (out.length) return { tone: "critical", text: `${out.map((u) => UTILITY_NAMES[u.kind]).join(" and ")} ${out.length > 1 ? "have" : "has"} run out` };
  if (critical.length) return { tone: "critical", text: `${UTILITY_NAMES[critical[0]!.kind]} will run out in ${durationLong(critical[0]!.forecast.hoursRemaining)}` };
  if (low.length) return { tone: "warning", text: `${low.map((u) => UTILITY_NAMES[u.kind]).join(" and ")} ${low.length > 1 ? "are" : "is"} running low` };
  if (o.needsAttention.length) return { tone: "warning", text: "Powered and connected, one purchase needs attention" };
  if (o.awaitingApproval.length) return { tone: "warning", text: "Powered and connected, a purchase awaits your approval" };
  return { tone: "positive", text: "Powered and connected" };
}

export default async function OverviewPage() {
  const o = await getHouseholdOverview(DEMO_HOUSEHOLD);
  const events = await getEvents(DEMO_HOUSEHOLD, { limit: 14 });
  const status = statusLine(o);
  const first = [...o.utilities].sort((a, b) => (a.forecast.hoursRemaining ?? Infinity) - (b.forecast.hoursRemaining ?? Infinity))[0];
  const s = o.budget.summary;

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="label mb-2.5">{o.household.name}</p>
          <h1 className="flex items-center gap-3 text-[26px] leading-8 font-semibold tracking-[-0.03em] text-fg">
            <span className={cn("inline-flex size-2.5 shrink-0 rounded-full", status.tone === "critical" ? "bg-coral" : status.tone === "warning" ? "bg-amber" : "bg-green")} aria-hidden />
            {status.text}
          </h1>
          <p className="mt-2 max-w-3xl text-[13px] text-fg-2">
            {o.latestDecision ? (
              <>
                <span className="text-fg-3">Latest decision:</span> {o.latestDecision.headline}.{" "}
                <Link href="/agent" className="font-medium text-fg underline decoration-fg/20 underline-offset-4 hover:decoration-fg/60">
                  See reasoning
                </Link>
              </>
            ) : (
              "Borderless hasn't assessed the household yet. Assessing reads every device, forecasts, and buys only what is needed."
            )}
          </p>
        </div>
        <RunAgentButton />
      </section>

      {(o.awaitingApproval.length > 0 || o.needsAttention.length > 0) && (
        <section aria-label="Needs you" className="space-y-2.5">
          {o.awaitingApproval.map((p) => (
            <ApprovalPrompt key={p.id} p={p} />
          ))}
          {o.needsAttention.map((p) => (
            <AttentionPrompt key={p.id} p={p} />
          ))}
        </section>
      )}

      <KpiStrip
        items={[
          {
            label: "Runs out first",
            value: first ? (first.balance <= 0 ? "Out now" : duration(first.forecast.hoursRemaining)) : "n/a",
            hint: first ? UTILITY_NAMES[first.kind] : undefined,
            tone: status.tone === "critical" ? "critical" : undefined,
          },
          { label: "Budget remaining", value: naira(s.remainingNgn), hint: `of ${naira(o.budget.amountNgn)} this ${o.budget.period === "monthly" ? "month" : "week"}` },
          { label: "Borderless can still spend", value: naira(Math.min(s.agentAuthorityRemainingNgn, s.remainingNgn)), hint: `of ${naira(o.policy.overallAgentLimitNgn)} authority` },
          { label: "Paid by Borderless", value: naira(s.spentNgn), hint: s.committedNgn > 0 ? `${naira(s.committedNgn)} committed` : "This period, on Stellar testnet" },
          {
            label: "Waiting on you",
            value: String(o.awaitingApproval.length + o.needsAttention.length),
            hint: o.awaitingApproval.length ? "Approval requested" : o.needsAttention.length ? "Needs attention" : "Nothing pending",
            tone: o.awaitingApproval.length + o.needsAttention.length > 0 ? "warning" : undefined,
          },
        ]}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel title="Service runway" description="How long each utility lasts at the current rate" actions={<span className="label">7 days</span>}>
          <Runway utilities={o.utilities} simNow={o.household.simNow} inFlight={o.inFlight} />
        </Panel>
        <BudgetPanel budget={o.budget} policy={o.policy} />
      </div>

      <section>
        <SectionLabel
          aside={
            <Link href="/household" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-fg-2 hover:text-fg">
              Devices <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          }
        >
          Utilities
        </SectionLabel>
        <div className="grid gap-4 md:grid-cols-3">
          {o.utilities.map((u) => (
            <UtilitySummary key={u.kind} u={u} />
          ))}
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel
          title="Latest decision"
          actions={
            <Link href="/agent" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-fg-2 hover:text-fg">
              All decisions <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          }
        >
          {o.latestDecision ? (
            <DecisionEntry d={o.latestDecision} compact />
          ) : (
            <EmptyState title="No decisions yet" action={<RunAgentButton variant="secondary" />}>
              Ask Borderless to assess the household, or advance simulated time from the demo controls.
            </EmptyState>
          )}
        </Panel>

        <Panel
          title="Activity"
          description="Household time, newest first"
          bodyClassName="px-4 pt-4 pb-0"
        >
          {events.length ? <ActivityTimeline events={events} dense /> : <EmptyState title="Nothing has happened yet">Activity appears here as Borderless monitors, decides and pays.</EmptyState>}
        </Panel>
      </div>
    </div>
  );
}
