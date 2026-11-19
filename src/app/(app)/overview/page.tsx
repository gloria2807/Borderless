import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ActivityTimeline } from "@/components/agent/activity-timeline";
import { ApprovalPrompt, AttentionPrompt, RunAgentButton } from "@/components/agent/actions";
import { DecisionEntry } from "@/components/agent/decision-entry";
import { ResetDemoButton, SimulateLowBalanceButton } from "@/components/demo/demo-actions";
import { AuthorityPanel } from "@/components/overview/authority-panel";
import { ElectricityHero } from "@/components/overview/electricity-hero";
import { Runway } from "@/components/overview/runway";
import { UtilitySummary } from "@/components/overview/utility-summary";
import { cn, EmptyState, KpiStrip, LiveChip, Panel, SectionLabel } from "@/components/ui/primitives";
import { duration, durationLong, UTILITY_NAMES } from "@/lib/format";
import type { Tone } from "@/lib/status";
import { activeRunFor } from "@/server/agent/runtime/executor";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { db } from "@/server/db/client";
import { accountFor, spendingAuthority } from "@/server/views/authority";
import { getEvents, getHouseholdOverview } from "@/server/views/household";
import { getRecentRuns } from "@/server/views/runs";

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

const usdc = (ngn: number, rate: number) => `${(ngn / rate).toFixed(2)}`;

export default async function OverviewPage() {
  const database = db();
  const [o, events, authority, meter, [lastRun]] = await Promise.all([
    getHouseholdOverview(DEMO_HOUSEHOLD),
    getEvents(DEMO_HOUSEHOLD, { limit: 14 }),
    spendingAuthority(database, DEMO_HOUSEHOLD),
    accountFor(database, DEMO_HOUSEHOLD, "electricity"),
    getRecentRuns(DEMO_HOUSEHOLD, 1),
  ]);
  // Show whichever is newer: a one-shot assessment or an agent run.
  const runIsNewer = lastRun?.summary && lastRun.status !== "running" && (!o.latestDecision || new Date(lastRun.startedAt) > new Date(o.latestDecision.createdAt ?? 0));
  const runId = activeRunFor(DEMO_HOUSEHOLD);
  const status = statusLine(o);
  const electricity = o.utilities.find((u) => u.kind === "electricity");
  const others = o.utilities.filter((u) => u.kind !== "electricity");
  const first = [...o.utilities].sort((a, b) => (a.forecast.hoursRemaining ?? Infinity) - (b.forecast.hoursRemaining ?? Infinity))[0];
  const r = authority.ngnPerUsdc;
  const waiting = o.awaitingApproval.length + o.needsAttention.length;
  const agentState = authority.paused
    ? { tone: "critical" as Tone, text: "Paused by you", live: false }
    : runId
      ? { tone: "info" as Tone, text: "Working on a task", live: true }
      : authority.autoPurchaseEnabled
        ? { tone: "positive" as Tone, text: "Monitoring", live: true }
        : { tone: "warning" as Tone, text: "Monitoring only (purchasing off)", live: false };

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
            <p className="label">
              {o.household.name}
              {o.household.owner ? ` · ${o.household.owner}, owner` : ""}
            </p>
            {runId ? (
              <Link href={`/agent/runs/${runId}`} className="rounded-full hover:opacity-80">
                <LiveChip live tone="info">
                  Borderless is working · watch live
                </LiveChip>
              </Link>
            ) : (
              <LiveChip live={agentState.live} tone={agentState.tone}>
                Borderless: {agentState.text}
              </LiveChip>
            )}
          </div>
          <h1 className="flex items-center gap-3 text-[26px] leading-8 font-semibold tracking-[-0.03em] text-fg">
            <span className={cn("inline-flex size-2.5 shrink-0 rounded-full", status.tone === "critical" ? "bg-coral" : status.tone === "warning" ? "bg-amber" : "bg-green")} aria-hidden />
            {status.text}
          </h1>
          <p className="mt-2 max-w-3xl text-[13px] text-fg-2">
            {runIsNewer ? (
              <>
                <span className="text-fg-3">Latest run:</span> {lastRun!.summary!.split(/(?<=\.)\s/)[0]}{" "}
                <Link href={`/agent/runs/${lastRun!.id}`} className="font-medium text-fg underline decoration-fg/20 underline-offset-4 hover:decoration-fg/60">
                  See the run
                </Link>
              </>
            ) : o.latestDecision ? (
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
        <div className="flex flex-wrap items-center gap-2">
          <ResetDemoButton />
          <RunAgentButton variant="secondary" />
          <SimulateLowBalanceButton disabled={authority.paused || !!runId} />
        </div>
      </section>

      {waiting > 0 && (
        <section aria-label="Needs you" className="space-y-2.5">
          {o.awaitingApproval.map((p) => (
            <ApprovalPrompt key={p.id} p={p} ngnPerUsdc={r} budgetLeftNgn={o.budget.summary.remainingNgn} autoLimitNgn={o.policy.manualApprovalThresholdNgn} />
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
          { label: "Spendable now, automatically", value: <>{authority.paused ? "0.00" : usdc(authority.spendableAutoNgn, r)} <span className="text-[13px] font-normal tracking-normal text-fg-3">USDC</span></>, hint: authority.paused ? "Paused by you" : `Up to ${usdc(authority.spendableMaxNgn, r)} USDC with approval` },
          { label: "Household budget left", value: <>{usdc(o.budget.summary.remainingNgn, r)} <span className="text-[13px] font-normal tracking-normal text-fg-3">USDC</span></>, hint: `of ${usdc(o.budget.amountNgn, r)} this ${o.budget.period === "monthly" ? "month" : "week"}` },
          { label: "Agent wallet", value: authority.wallet.balanceUsdc ? <>{authority.wallet.balanceUsdc} <span className="text-[13px] font-normal tracking-normal text-fg-3">USDC</span></> : "—", hint: authority.wallet.balanceUsdc ? "Stellar testnet, live" : "Couldn't read the balance" },
          { label: "Waiting on you", value: String(waiting), hint: o.awaitingApproval.length ? "Approval requested" : o.needsAttention.length ? "Needs attention" : "Nothing pending", tone: waiting > 0 ? "warning" : undefined },
        ]}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          {electricity && <ElectricityHero u={electricity} distributionCompany={meter?.distributionCompany ?? null} />}
          <Panel title="Service runway" description="How long each utility lasts at the current rate" actions={<span className="label">7 days</span>}>
            <Runway utilities={o.utilities} simNow={o.household.simNow} inFlight={o.inFlight} />
          </Panel>
        </div>
        <AuthorityPanel a={authority} />
      </div>

      <section>
        <SectionLabel
          aside={
            <Link href="/household" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-fg-2 hover:text-fg">
              Devices <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          }
        >
          Airtime and data
        </SectionLabel>
        <div className="grid gap-4 md:grid-cols-2">
          {others.map((u) => (
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
              Press Simulate low balance, or ask Borderless to assess the household.
            </EmptyState>
          )}
        </Panel>

        <Panel title="Activity" description="Household time, newest first" bodyClassName="px-4 pt-4 pb-0">
          {events.length ? <ActivityTimeline events={events} dense /> : <EmptyState title="Nothing has happened yet">Activity appears here as Borderless monitors, decides and pays.</EmptyState>}
        </Panel>
      </div>
    </div>
  );
}
