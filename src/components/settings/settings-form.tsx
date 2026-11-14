"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
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
  intelligenceCapNgn: number;
  approvalTtlSeconds: number;
  /** 0 = no separate cap for that utility. */
  maxPerUtilityNgn: Record<Kind, number>;
  approvedProviderIds: string[];
}

export interface ProviderOption {
  id: string;
  name: string;
  kind: Kind;
  category: "utility" | "intelligence";
  eligible: boolean;
  eligibility: string;
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-line-soft py-7 last:border-b-0 md:grid-cols-[260px_minmax(0,1fr)] md:gap-10">
      <div>
        <h2 className="text-[13.5px] font-semibold tracking-[-0.005em] text-fg">{title}</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** Edits an amount in test USDC; stores it as naira of household value at the fixed demo rate. */
function MoneyField({ label, help, value, onChange, rate }: { label: string; help?: string; value: number; onChange: (n: number) => void; rate: number }) {
  const id = useId();
  const [text, setText] = useState(() => (value / rate).toFixed(2));
  // Re-sync when the value changes from outside (Discard changes, a fresh load), not while typing.
  useEffect(() => {
    setText((t) => (Math.round(Number(t) * rate) === value ? t : (value / rate).toFixed(2)));
  }, [value, rate]);
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium text-fg-2">
        {label}
      </label>
      <div className="mt-1.5 flex h-9 max-w-[240px] items-center rounded-lg border border-line bg-raised transition-shadow focus-within:border-green focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-green)_15%,transparent)]">
        <input
          id={id}
          inputMode="decimal"
          className="mono h-full w-full bg-transparent pl-3 text-[13px] text-fg outline-none"
          value={text}
          onChange={(e) => {
            const t = e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
            setText(t);
            const n = Number(t);
            onChange(Number.isFinite(n) ? Math.round(n * rate) : 0);
          }}
          onBlur={() => setText((value / rate).toFixed(2))}
          aria-describedby={`${id}-help`}
        />
        <span className="pr-3 pl-1 text-[12px] font-medium text-fg-3">USDC</span>
      </div>
      <p id={`${id}-help`} className="mt-1 text-2xs text-fg-3">
        <span className="mono">{naira(value)}</span> of household value{help ? ` · ${help}` : ""}
      </p>
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
      <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1.5 block h-9 rounded-lg border border-line bg-raised px-2 text-[13px] text-fg outline-none focus:border-green focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-green)_15%,transparent)]">
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

export function SettingsForm({ initial, spentNgn, rate, providers }: { initial: SettingsValues; spentNgn: number; rate: number; providers: ProviderOption[] }) {
  const [v, setV] = useState<SettingsValues>(initial);
  const { run, pending } = useApiAction();
  const set = <K extends keyof SettingsValues>(k: K, value: SettingsValues[K]) => setV((x) => ({ ...x, [k]: value }));
  const dirty = useMemo(() => JSON.stringify(v) !== JSON.stringify(initial), [v, initial]);
  const nameId = useId();

  const warnings: string[] = [];
  if (v.manualApprovalThresholdNgn > v.perPurchaseLimitNgn) warnings.push("The automatic limit is above the largest single request, so Borderless will never ask for approval.");
  if (v.perPurchaseLimitNgn > v.taskBudgetNgn && v.taskBudgetNgn > 0) warnings.push("The largest single request is above the per-task budget, so the task budget is what binds.");
  if (v.overallAgentLimitNgn > v.budgetAmountNgn) warnings.push("The agent limit is above the budget. The budget still caps spending.");
  if (v.reserveNgn >= v.budgetAmountNgn && v.budgetAmountNgn > 0) warnings.push("The reserve is as large as the budget, so Borderless can't buy anything.");
  if (v.dailyAgentBudgetNgn === 0 || v.taskBudgetNgn === 0) warnings.push("A 0 USDC daily or per-task limit stops Borderless from buying anything.");
  else if (v.dailyAgentBudgetNgn < v.perPurchaseLimitNgn) warnings.push("The daily limit is below the largest single request, so the daily limit is what binds.");
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
      <div className={cn("mb-2 flex flex-wrap items-center justify-between gap-4 rounded-lg p-4", v.autoPurchaseEnabled ? "bg-surface shadow-ring" : "bg-coral-soft shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-coral)_30%,transparent)]")}>
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

      <Section title="Spending authority" description="The owner's delegated limits, in test USDC. Checked in code before every payment is signed; the AI cannot change or exceed them.">
        <MoneyField rate={rate} label="Automatic purchases, up to (per request)" value={v.manualApprovalThresholdNgn} onChange={(n) => set("manualApprovalThresholdNgn", n)} help="Anything above waits for your approval." />
        <MoneyField rate={rate} label="Largest single request, even with approval" value={v.perPurchaseLimitNgn} onChange={(n) => set("perPurchaseLimitNgn", n)} help="Refused outright above this." />
        <MoneyField rate={rate} label="Each agent task, up to" value={v.taskBudgetNgn} onChange={(n) => set("taskBudgetNgn", n)} help="One run can't spend more, however many utilities need help." />
        <MoneyField rate={rate} label="Each day, up to" value={v.dailyAgentBudgetNgn} onChange={(n) => set("dailyAgentBudgetNgn", n)} help="Resets at midnight, household time." />
        <MoneyField rate={rate} label="This period, up to" value={v.overallAgentLimitNgn} onChange={(n) => set("overallAgentLimitNgn", n)} help="Your own purchases don't count towards this." />
        <MoneyField rate={rate} label="Each information purchase, up to" value={v.intelligenceCapNgn} onChange={(n) => set("intelligenceCapNgn", n)} help="For example a paid meter diagnostic." />
        <ApprovalWindow value={v.approvalTtlSeconds} onChange={(n) => set("approvalTtlSeconds", n)} />
        <p className="text-[12px] text-fg-3">Whatever these allow, Borderless can never spend more than its testnet wallet holds.</p>
      </Section>

      <Section title="Household budget" description="All household purchases come out of this budget, including your own.">
        <MoneyField rate={rate} label="Budget" value={v.budgetAmountNgn} onChange={(n) => set("budgetAmountNgn", n)} />
        <fieldset>
          <legend className="text-[13px] font-medium text-fg-2">Period</legend>
          <div className="mt-1.5 inline-flex rounded-full bg-fg/[0.06] p-0.5">
            {(["weekly", "monthly"] as const).map((p) => (
              <label key={p} className={cn("cursor-pointer rounded-full px-3 py-1 text-[12.5px] font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-green", v.budgetPeriod === p ? "bg-raised text-fg shadow-ring" : "text-fg-3")}>
                <input type="radio" name="period" value={p} checked={v.budgetPeriod === p} onChange={() => set("budgetPeriod", p)} className="sr-only" />
                {p === "weekly" ? "Weekly" : "Monthly"}
              </label>
            ))}
          </div>
        </fieldset>
        <MoneyField rate={rate} label="Always keep in reserve" value={v.reserveNgn} onChange={(n) => set("reserveNgn", n)} help="Borderless won't spend the last part of the budget." />
        <fieldset>
          <legend className="text-[13px] font-medium text-fg-2">Cap per request, by utility</legend>
          <p className="mt-0.5 text-2xs text-fg-3">0 means no separate cap.</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            {(["electricity", "airtime", "data"] as const).map((k) => (
              <MoneyField rate={rate} key={k} label={UTILITY_NAMES[k]} value={v.maxPerUtilityNgn[k]} onChange={(n) => set("maxPerUtilityNgn", { ...v.maxPerUtilityNgn, [k]: n })} />
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Priorities" description="When two needs are equally urgent and the budget can't cover both, the higher one wins.">
        <ol className="max-w-sm space-y-2">
          {v.priorities.map((k, i) => (
            <li key={k} className="flex items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2">
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

      <Section title="Approved services, networks and providers" description="Borderless only buys what you approve here, and only from providers that can actually serve your accounts.">
        <fieldset>
          <legend className="text-[13px] font-medium text-fg-2">Services</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["electricity", "airtime", "data"] as const).map((k) => (
              <label key={k} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-green", v.approvedServices.includes(k) ? "border-green/40 bg-green-soft text-fg" : "border-line text-fg-3")}>
                <input type="checkbox" className="accent-green" checked={v.approvedServices.includes(k)} onChange={() => set("approvedServices", toggleIn(v.approvedServices, k))} />
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
                <input type="checkbox" className="accent-green" checked={v.approvedNetworks.includes(n)} onChange={() => set("approvedNetworks", toggleIn(v.approvedNetworks, n))} />
                {NETWORK_NAMES[n]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[13px] font-medium text-fg-2">Provider allowlist</legend>
          <p className="mt-0.5 text-2xs text-fg-3">Registered demo providers only. Unticked providers can still be discovered, but never paid.</p>
          <ul className="mt-2 divide-y divide-line-soft overflow-hidden rounded-lg bg-raised shadow-ring">
            {providers.map((p) => (
              <li key={p.id}>
                <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-green">
                  <input type="checkbox" className="mt-0.5 accent-green" checked={v.approvedProviderIds.includes(p.id)} onChange={() => set("approvedProviderIds", toggleIn(v.approvedProviderIds, p.id))} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-fg">{p.name}</span>
                    <span className="block text-2xs text-fg-3">
                      {UTILITY_NAMES[p.kind]} · {p.category === "utility" ? "utility credit" : "information service"} · {p.eligibility}
                    </span>
                  </span>
                  {!p.eligible && <span className="rounded-full bg-fg/[0.06] px-2 py-px text-2xs font-medium text-fg-3">Not eligible</span>}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </Section>

      <Section title="Household" description="Shown across the app.">
        <div>
          <label htmlFor={nameId} className="text-[13px] font-medium text-fg-2">
            Household name
          </label>
          <input id={nameId} value={v.householdName} onChange={(e) => set("householdName", e.target.value)} maxLength={60} className="mt-1.5 h-9 w-full max-w-sm rounded-lg border border-line bg-raised px-3 text-[13px] text-fg outline-none focus:border-green focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-green)_15%,transparent)]" />
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
