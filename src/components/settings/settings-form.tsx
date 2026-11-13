"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ShieldOff } from "lucide-react";
import { Button, cn } from "@/components/ui/primitives";
import { Toggle, useApiAction } from "@/components/ui/interactive";
import { naira, NETWORK_NAMES, UTILITY_NAMES } from "@/lib/format";

type Kind = "electricity" | "airtime" | "data";
type Net = "mtn" | "airtel" | "glo" | "t2";

export interface SettingsValues {
  householdName: string;
  budgetAmountNgn: number;
  budgetPeriod: "weekly" | "monthly";
  autoPurchaseEnabled: boolean;
  perPurchaseLimitNgn: number;
  overallAgentLimitNgn: number;
  manualApprovalThresholdNgn: number;
  priorities: Kind[];
  approvedServices: Kind[];
  approvedNetworks: Net[];
  dailyAgentBudgetNgn: number;
  taskBudgetNgn: number;
  reserveNgn: number;
  approvalTtlSeconds: number;
  /** 0 = no separate cap for that utility. */
  maxPerUtilityNgn: Record<Kind, number>;
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-line-soft py-6 last:border-b-0 md:grid-cols-[260px_minmax(0,1fr)] md:gap-10">
      <div>
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <p className="mt-1 text-[13px] text-fg-3">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function MoneyField({ label, help, value, onChange }: { label: string; help?: string; value: number; onChange: (n: number) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium text-fg-2">
        {label}
      </label>
      <div className="mt-1.5 flex h-9 max-w-[220px] items-center rounded-md border border-line bg-bg-2 focus-within:border-green">
        <span className="pl-3 text-fg-3">₦</span>
        <input
          id={id}
          inputMode="numeric"
          className="mono h-full w-full bg-transparent px-2 text-[13px] text-fg outline-none"
          value={Number.isFinite(value) ? value.toLocaleString("en-NG") : ""}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^\d]/g, ""));
            onChange(Number.isFinite(n) ? n : 0);
          }}
          aria-describedby={help ? `${id}-help` : undefined}
        />
      </div>
      {help && (
        <p id={`${id}-help`} className="mt-1 text-2xs text-fg-3">
          {help}
        </p>
      )}
    </div>
  );
}

const WINDOWS: [number, string][] = [
  [60, "1 minute"],
  [180, "3 minutes"],
  [600, "10 minutes"],
  [3600, "1 hour"],
  [86_400, "1 day"],
];

function ApprovalWindow({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const id = useId();
  const options = WINDOWS.some(([s]) => s === value) ? WINDOWS : [[value, `${value} seconds`] as [number, string], ...WINDOWS];
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium text-fg-2">
        Approval requests expire after
      </label>
      <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1.5 block h-9 rounded-md border border-line bg-bg-2 px-2 text-[13px] text-fg outline-none focus:border-green">
        {options.map(([s, label]) => (
          <option key={s} value={s}>
            {label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-2xs text-fg-3">An unanswered request is cancelled unpaid, and Borderless reassesses with fresh prices.</p>
    </div>
  );
}

export function SettingsForm({ initial, spentNgn }: { initial: SettingsValues; spentNgn: number }) {
  const [v, setV] = useState<SettingsValues>(initial);
  const { run, pending } = useApiAction();
  const set = <K extends keyof SettingsValues>(k: K, value: SettingsValues[K]) => setV((x) => ({ ...x, [k]: value }));
  const dirty = useMemo(() => JSON.stringify(v) !== JSON.stringify(initial), [v, initial]);
  const nameId = useId();

  const warnings: string[] = [];
  if (v.manualApprovalThresholdNgn > v.perPurchaseLimitNgn) warnings.push("The approval threshold is above the per-purchase limit, so Borderless will never ask for approval.");
  if (v.overallAgentLimitNgn > v.budgetAmountNgn) warnings.push("The agent limit is above the budget. The budget still caps spending.");
  if (v.reserveNgn >= v.budgetAmountNgn && v.budgetAmountNgn > 0) warnings.push("The reserve is as large as the budget, so Borderless can't buy anything.");
  if (v.dailyAgentBudgetNgn === 0 || v.taskBudgetNgn === 0) warnings.push("A ₦0 daily or per-run limit stops Borderless from buying anything.");
  else if (v.dailyAgentBudgetNgn < v.perPurchaseLimitNgn) warnings.push("The daily limit is below the per-purchase limit, so the daily limit is what binds.");
  if (v.budgetAmountNgn < spentNgn) warnings.push(`The new budget is below what's already spent this period (${naira(spentNgn)}). Borderless won't buy anything until the next period.`);

  const move = (i: number, d: -1 | 1) => {
    const next = [...v.priorities];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    set("priorities", next);
  };
  const toggleIn = <T extends string>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run("/api/settings", { method: "PUT", body: v }, { success: () => ({ title: "Settings saved", body: "Borderless will use the new rules from its next decision." }), errorTitle: "Settings not saved" });
      }}
    >
      {/* Authority first: the most important control on this page. */}
      <div className={cn("mb-2 flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4", v.autoPurchaseEnabled ? "border-line bg-surface" : "border-coral/30 bg-coral-soft")}>
        <div className="flex items-start gap-3">
          <ShieldOff className={cn("mt-0.5 size-5", v.autoPurchaseEnabled ? "text-fg-3" : "text-coral")} aria-hidden />
          <div>
            <p className="text-sm font-semibold">Automatic purchasing</p>
            <p className="text-[13px] text-fg-2">
              {v.autoPurchaseEnabled
                ? "Borderless can buy within the limits below without asking, and asks you above the approval threshold."
                : "Revoked. Borderless keeps monitoring and recommending, but won't spend anything."}
            </p>
          </div>
        </div>
        <Toggle checked={v.autoPurchaseEnabled} onChange={(x) => set("autoPurchaseEnabled", x)} label="Automatic purchasing" />
      </div>

      <Section title="Spending limits" description="Checked on the server before every payment is signed. Borderless cannot exceed them.">
        <MoneyField label="Per purchase, up to" value={v.perPurchaseLimitNgn} onChange={(n) => set("perPurchaseLimitNgn", n)} help="No single purchase can be larger than this." />
        <MoneyField label="Ask me before purchases above" value={v.manualApprovalThresholdNgn} onChange={(n) => set("manualApprovalThresholdNgn", n)} help="Larger purchases wait for your approval." />
        <ApprovalWindow value={v.approvalTtlSeconds} onChange={(n) => set("approvalTtlSeconds", n)} />
        <MoneyField label="Total Borderless can spend this period" value={v.overallAgentLimitNgn} onChange={(n) => set("overallAgentLimitNgn", n)} help="Your own purchases don't count towards this." />
      </Section>

      <Section title="Budget allocation" description="How Borderless shares money between days, runs and utilities. Also enforced on the server before signing.">
        <MoneyField label="Borderless can spend per day, up to" value={v.dailyAgentBudgetNgn} onChange={(n) => set("dailyAgentBudgetNgn", n)} help="Resets at midnight, household time." />
        <MoneyField label="Each agent run can spend, up to" value={v.taskBudgetNgn} onChange={(n) => set("taskBudgetNgn", n)} help="A single assessment can't spend more than this, however many utilities need help." />
        <MoneyField label="Always keep in reserve" value={v.reserveNgn} onChange={(n) => set("reserveNgn", n)} help="Borderless won't spend the last part of the budget. Your own purchases can." />
        <fieldset>
          <legend className="text-[13px] font-medium text-fg-2">Per-purchase cap by utility</legend>
          <p className="mt-0.5 text-2xs text-fg-3">₦0 means no separate cap (the per-purchase limit applies).</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            {(["electricity", "airtime", "data"] as const).map((k) => (
              <MoneyField key={k} label={UTILITY_NAMES[k]} value={v.maxPerUtilityNgn[k]} onChange={(n) => set("maxPerUtilityNgn", { ...v.maxPerUtilityNgn, [k]: n })} />
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Household budget" description="All household purchases come out of this budget, including your own.">
        <MoneyField label="Budget" value={v.budgetAmountNgn} onChange={(n) => set("budgetAmountNgn", n)} />
        <fieldset>
          <legend className="text-[13px] font-medium text-fg-2">Period</legend>
          <div className="mt-1.5 inline-flex rounded-md border border-line p-0.5">
            {(["weekly", "monthly"] as const).map((p) => (
              <label key={p} className={cn("cursor-pointer rounded-sm px-3 py-1 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-green", v.budgetPeriod === p ? "bg-raised text-fg" : "text-fg-3")}>
                <input type="radio" name="period" value={p} checked={v.budgetPeriod === p} onChange={() => set("budgetPeriod", p)} className="sr-only" />
                {p === "weekly" ? "Weekly" : "Monthly"}
              </label>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Priorities" description="When two needs are equally urgent and the budget can't cover both, the higher one wins.">
        <ol className="max-w-sm space-y-2">
          {v.priorities.map((k, i) => (
            <li key={k} className="flex items-center gap-3 rounded-md border border-line bg-bg-2 px-3 py-2">
              <span className="mono w-4 text-2xs text-fg-3">{i + 1}</span>
              <span className="flex-1 text-[13px] font-medium">{UTILITY_NAMES[k]}</span>
              <button type="button" className="rounded-sm p-1 text-fg-3 hover:bg-raised hover:text-fg disabled:opacity-30" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${UTILITY_NAMES[k]} up`}>
                <ArrowUp className="size-3.5" />
              </button>
              <button type="button" className="rounded-sm p-1 text-fg-3 hover:bg-raised hover:text-fg disabled:opacity-30" onClick={() => move(i, 1)} disabled={i === v.priorities.length - 1} aria-label={`Move ${UTILITY_NAMES[k]} down`}>
                <ArrowDown className="size-3.5" />
              </button>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Approved services and networks" description="Borderless only buys what you approve here.">
        <fieldset>
          <legend className="text-[13px] font-medium text-fg-2">Services</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["electricity", "airtime", "data"] as const).map((k) => (
              <label key={k} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-green", v.approvedServices.includes(k) ? "border-green/40 bg-green-soft text-fg" : "border-line text-fg-3")}>
                <input type="checkbox" className="accent-[#b8df76]" checked={v.approvedServices.includes(k)} onChange={() => set("approvedServices", toggleIn(v.approvedServices, k))} />
                {UTILITY_NAMES[k]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[13px] font-medium text-fg-2">Mobile networks</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["mtn", "airtel", "glo", "t2"] as const).map((n) => (
              <label key={n} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-green", v.approvedNetworks.includes(n) ? "border-green/40 bg-green-soft text-fg" : "border-line text-fg-3")}>
                <input type="checkbox" className="accent-[#b8df76]" checked={v.approvedNetworks.includes(n)} onChange={() => set("approvedNetworks", toggleIn(v.approvedNetworks, n))} />
                {NETWORK_NAMES[n]}
              </label>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Household" description="Shown across the app.">
        <div>
          <label htmlFor={nameId} className="text-[13px] font-medium text-fg-2">
            Household name
          </label>
          <input id={nameId} value={v.householdName} onChange={(e) => set("householdName", e.target.value)} maxLength={60} className="mt-1.5 h-9 w-full max-w-sm rounded-md border border-line bg-bg-2 px-3 text-[13px] text-fg outline-none focus:border-green" />
        </div>
      </Section>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft bg-bg/95 px-1 py-3 backdrop-blur">
        <div className="min-h-5 text-2xs text-amber" aria-live="polite">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" disabled={!dirty || pending} onClick={() => setV(initial)}>
            Discard changes
          </Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!dirty || !v.householdName.trim()}>
            Save changes
          </Button>
        </div>
      </div>
    </form>
  );
}
