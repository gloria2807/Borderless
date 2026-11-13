import type { Metadata } from "next";
import { ActivityTimeline } from "@/components/agent/activity-timeline";
import { ApprovalPrompt, AttentionPrompt, RunAgentButton } from "@/components/agent/actions";
import { AuthorityPanel } from "@/components/agent/authority";
import { DecisionEntry } from "@/components/agent/decision-entry";
import { RunLauncher } from "@/components/agent/run-launcher";
import { RecentRuns } from "@/components/agent/recent-runs";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { getDecisions, getEvents, getHouseholdOverview } from "@/server/views/household";
import { getRecentRuns, launcherInfo } from "@/server/views/runs";

export const metadata: Metadata = { title: "Agent" };
export const dynamic = "force-dynamic";

export default async function AgentPage() {
  const [o, decisions, events, runs] = await Promise.all([
    getHouseholdOverview(DEMO_HOUSEHOLD),
    getDecisions(DEMO_HOUSEHOLD, 25),
    getEvents(DEMO_HOUSEHOLD, { limit: 80 }),
    getRecentRuns(DEMO_HOUSEHOLD, 8),
  ]);
  const launcher = launcherInfo();

  return (
    <>
      <PageHeader
        title="Agent"
        description="What Borderless noticed, what it predicted, what it decided and why. Purchasing rules are fixed code; the wording below is generated from the same data."
        actions={<RunAgentButton />}
      />

      {(o.awaitingApproval.length > 0 || o.needsAttention.length > 0) && (
        <div className="mb-6 space-y-2">
          {o.awaitingApproval.map((p) => (
            <ApprovalPrompt key={p.id} p={p} />
          ))}
          {o.needsAttention.map((p) => (
            <AttentionPrompt key={p.id} p={p} />
          ))}
        </div>
      )}

      <div className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Agent operations" description="Give Borderless a task and watch every step live">
          <RunLauncher aiAvailable={launcher.aiAvailable} model={launcher.model} defaultTask={launcher.defaultTask} />
        </Panel>
        <Panel title="Recent runs" description="Newest first" bodyClassName="p-0">
          <RecentRuns runs={runs} />
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Decisions" description="Newest first" bodyClassName="p-0">
          {decisions.length ? (
            <ol className="divide-y divide-line-soft">
              {decisions.map((d) => (
                <li key={d.id} className="px-5 py-5">
                  <DecisionEntry d={d} />
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No decisions yet" action={<RunAgentButton variant="secondary" />}>
              Borderless assesses the household whenever simulated time advances, or when you ask it to.
            </EmptyState>
          )}
        </Panel>

        <div className="space-y-6">
          <AuthorityPanel o={o} />
          <Panel title="Full activity log" description="Household time, newest first" bodyClassName="max-h-[720px] overflow-y-auto px-5 pt-5 pb-1">
            {events.length ? <ActivityTimeline events={events} /> : <EmptyState title="No activity yet" />}
          </Panel>
        </div>
      </div>
    </>
  );
}
