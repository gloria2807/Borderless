import Link from "next/link";
import { ActivityTimeline } from "@/components/agent/activity-timeline";
import { ApprovalPrompt, AttentionPrompt, RunAgentButton } from "@/components/agent/actions";
import { DecisionEntry } from "@/components/agent/decision-entry";
import { BudgetPanel } from "@/components/overview/budget";
import { Runway } from "@/components/overview/runway";
import { UtilitySummary } from "@/components/overview/utility-summary";
import { EmptyState, Panel } from "@/components/ui/primitives";
import { durationLong, UTILITY_NAMES } from "@/lib/format";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { getEvents, getHouseholdOverview } from "@/server/views/household";

export const dynamic = "force-dynamic";

function statusLine(o: Awaited<ReturnType<typeof getHouseholdOverview>>) {
  const byUrgency = [...o.utilities].sort((a, b) => (a.forecast.hoursRemaining ?? Infinity) - (b.forecast.hoursRemaining ?? Infinity));
  const out = byUrgency.filter((u) => u.balance <= 0);
  const critical = byUrgency.filter((u) => u.forecast.urgency === "critical" && u.balance > 0);
  const low = byUrgency.filter((u) => u.forecast.urgency === "low");
  if (out.length) return { tone: "text-coral", text: `${out.map((u) => UTILITY_NAMES[u.kind]).join(" and ")} ${out.length > 1 ? "have" : "has"} run out` };
  if (critical.length) return { tone: "text-coral", text: `${UTILITY_NAMES[critical[0]!.kind]} will run out in ${durationLong(critical[0]!.forecast.hoursRemaining)}` };
  if (low.length) return { tone: "text-amber", text: `${low.map((u) => UTILITY_NAMES[u.kind]).join(" and ")} ${low.length > 1 ? "are" : "is"} running low` };
  if (o.needsAttention.length) return { tone: "text-amber", text: "Powered and connected, one purchase needs attention" };
  if (o.awaitingApproval.length) return { tone: "text-amber", text: "Powered and connected, a purchase awaits your approval" };
  return { tone: "text-green", text: "Powered and connected" };
}

export default async function OverviewPage() {
  const o = await getHouseholdOverview(DEMO_HOUSEHOLD);
  const events = await getEvents(DEMO_HOUSEHOLD, { limit: 14 });
  const status = statusLine(o);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[13px] text-fg-3">{o.household.name}</p>
          <h1 className={`mt-1 text-2xl font-bold tracking-[-0.02em] ${status.tone}`}>{status.text}</h1>
          <p className="mt-1 text-[13px] text-fg-2">
            {o.latestDecision ? (
              <>
                Borderless: {o.latestDecision.headline.charAt(0).toLowerCase() + o.latestDecision.headline.slice(1)}.{" "}
                <Link href="/agent" className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg-2">
                  See reasoning
                </Link>
              </>
            ) : (
              "Borderless hasn't assessed the household yet."
            )}
          </p>
        </div>
        <RunAgentButton />
      </section>

      {(o.awaitingApproval.length > 0 || o.needsAttention.length > 0) && (
        <div className="space-y-2">
          {o.awaitingApproval.map((p) => (
            <ApprovalPrompt key={p.id} p={p} />
          ))}
          {o.needsAttention.map((p) => (
            <AttentionPrompt key={p.id} p={p} />
          ))}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel title="Service runway" description="How long each utility will last at the current rate">
          <Runway utilities={o.utilities} simNow={o.household.simNow} inFlight={o.inFlight} />
        </Panel>
        <BudgetPanel budget={o.budget} policy={o.policy} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            {o.utilities.map((u) => (
              <UtilitySummary key={u.kind} u={u} />
            ))}
          </div>
          <Panel title="Latest decision" actions={<Link href="/agent" className="text-[13px] font-medium text-fg-2 hover:text-fg">All decisions</Link>}>
            {o.latestDecision ? (
              <DecisionEntry d={o.latestDecision} compact />
            ) : (
              <EmptyState title="No decisions yet" action={<RunAgentButton variant="secondary" />}>
                Ask Borderless to assess the household, or advance simulated time from the demo controls.
              </EmptyState>
            )}
          </Panel>
        </div>

        <Panel title="Activity" description="Household time, newest first" bodyClassName="px-5 pt-5 pb-1">
          {events.length ? <ActivityTimeline events={events} dense /> : <EmptyState title="Nothing has happened yet">Activity appears here as Borderless monitors, decides and pays.</EmptyState>}
        </Panel>
      </div>
    </div>
  );
}
