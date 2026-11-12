import { calendarDate, naira } from "@/lib/format";
import { cn, Panel } from "@/components/ui/primitives";
import type { HouseholdOverview } from "@/server/views/household";

export function BudgetPanel({ budget, policy }: { budget: HouseholdOverview["budget"]; policy: HouseholdOverview["policy"] }) {
  const s = budget.summary;
  const total = Math.max(budget.amountNgn, 1);
  const segs = [
    { key: "prior", value: budget.priorSpendNgn, cls: "bg-fg-3/60", label: "Spent earlier this period" },
    { key: "spent", value: s.spentNgn, cls: "bg-green", label: "Paid by Borderless" },
    { key: "committed", value: s.committedNgn, cls: "bg-amber", label: "Pending commitments" },
  ];
  const endInclusive = new Date(new Date(budget.periodEnd).getTime() - 86_400_000);

  return (
    <Panel title="Household budget" description={`${budget.period === "monthly" ? "Monthly" : "Weekly"}, ${calendarDate(budget.periodStart)} to ${calendarDate(endInclusive)}`}>
      <p className="text-[13px] text-fg-3">Remaining</p>
      <p className="mono mt-0.5 text-[28px] leading-none font-medium tracking-[-0.02em] text-fg">{naira(s.remainingNgn)}</p>
      <p className="mt-1.5 text-[13px] text-fg-3">of {naira(budget.amountNgn)}</p>

      <div className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-line-soft" role="img" aria-label={`Budget: ${naira(s.remainingNgn)} of ${naira(budget.amountNgn)} remaining`}>
        {segs.map((x) => (x.value > 0 ? <div key={x.key} className={cn("h-full", x.cls)} style={{ width: `${(x.value / total) * 100}%` }} /> : null))}
      </div>

      <dl className="mt-4 divide-y divide-line-soft">
        {segs.map((x) => (
          <div key={x.key} className="flex items-center justify-between py-2 text-[13px]">
            <dt className="flex items-center gap-2 text-fg-2">
              <span className={cn("size-2 rounded-[2px]", x.cls)} aria-hidden />
              {x.label}
            </dt>
            <dd className="mono text-fg">{naira(x.value)}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between py-2 text-[13px]">
          <dt className="text-fg-2">Borderless can still spend</dt>
          <dd className="mono text-fg">
            {naira(Math.min(s.agentAuthorityRemainingNgn, s.remainingNgn))}
            <span className="ml-1 font-sans text-2xs text-fg-3">of {naira(policy.overallAgentLimitNgn)} authority</span>
          </dd>
        </div>
      </dl>
    </Panel>
  );
}
