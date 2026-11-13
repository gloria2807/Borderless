import { calendarDate, naira } from "@/lib/format";
import { cn, Panel } from "@/components/ui/primitives";
import type { HouseholdOverview } from "@/server/views/household";

export function BudgetPanel({ budget, policy }: { budget: HouseholdOverview["budget"]; policy: HouseholdOverview["policy"] }) {
  const s = budget.summary;
  const total = Math.max(budget.amountNgn, 1);
  const segs = [
    { key: "prior", value: budget.priorSpendNgn, cls: "bg-fg-4", label: "Spent earlier this period" },
    { key: "spent", value: s.spentNgn, cls: "bg-green", label: "Paid by Borderless" },
    { key: "committed", value: s.committedNgn, cls: "bg-amber", label: "Pending commitments" },
  ];
  const endInclusive = new Date(new Date(budget.periodEnd).getTime() - 86_400_000);

  return (
    <Panel title="Household budget" description={`${budget.period === "monthly" ? "Monthly" : "Weekly"}, ${calendarDate(budget.periodStart)} to ${calendarDate(endInclusive)}`}>
      <p className="text-[11.5px] text-fg-3">Remaining</p>
      <p className="mt-1 text-[28px] leading-none font-semibold tracking-[-0.035em] text-fg tabular">
        {naira(s.remainingNgn)}
        <span className="ml-2 text-[13px] font-normal tracking-normal text-fg-3">of {naira(budget.amountNgn)}</span>
      </p>

      <div className="mt-4 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-fg/[0.07]" role="img" aria-label={`Budget: ${naira(s.remainingNgn)} of ${naira(budget.amountNgn)} remaining`}>
        {segs.map((x) => (x.value > 0 ? <div key={x.key} className={cn("h-full", x.cls)} style={{ width: `${(x.value / total) * 100}%` }} /> : null))}
      </div>

      <dl className="mt-3 divide-y divide-line-soft">
        {segs.map((x) => (
          <div key={x.key} className="flex items-center justify-between py-2 text-[13px]">
            <dt className="flex items-center gap-2 text-fg-2">
              <span className={cn("size-2 rounded-full", x.cls)} aria-hidden />
              {x.label}
            </dt>
            <dd className="text-fg tabular">{naira(x.value)}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between py-2 text-[13px]">
          <dt className="text-fg-2">Borderless can still spend</dt>
          <dd className="text-fg tabular">
            {naira(Math.min(s.agentAuthorityRemainingNgn, s.remainingNgn))}
            <span className="ml-1 font-sans text-2xs text-fg-3">of {naira(policy.overallAgentLimitNgn)} authority</span>
          </dd>
        </div>
      </dl>
    </Panel>
  );
}
