import { dayTime, duration, meterId, naira, quantity } from "@/lib/format";
import { URGENCY } from "@/lib/status";
import { cn, SimulatedTag, StatusPill } from "@/components/ui/primitives";
import type { UtilityView } from "@/server/views/household";
import { UsageStrip } from "./usage-strip";

/** Virtual prepaid electricity meter. Simulated device; demo tokens are never valid on real meters. */
export function VirtualMeter({ u, simNow }: { u: UtilityView; simNow: string }) {
  const last = u.lastPurchase;
  const fresh = last && last.at === simNow; // credited at the current household time
  const urgency = URGENCY[u.forecast.urgency]!;
  const display = u.balance.toFixed(1).padStart(6, " ");

  return (
    <div className="rounded-lg bg-surface p-4 shadow-ring">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-semibold">Prepaid meter</p>
          <p className="text-2xs text-fg-3">{u.providerName}</p>
        </div>
        <SimulatedTag>Simulated device</SimulatedTag>
      </div>

      {/* Display window */}
      <div className="mt-4 rounded-[10px] bg-ink p-1.5">
      <div className={cn("rounded-md bg-lcd px-4 py-3 shadow-[inset_0_1px_3px_rgb(12_13_12/0.25)]", fresh && "animate-credit")}>
        <div className="flex items-center justify-between text-2xs text-lcd-dim">
          <span className="mono tracking-[0.1em] uppercase">Credit</span>
          <StatusPill tone={urgency.tone}>{urgency.label}</StatusPill>
        </div>
        <p className="mono mt-1.5 text-right text-[40px] leading-none font-medium tracking-[0.04em] whitespace-pre text-lcd-fg" aria-label={`${u.balance} kilowatt hours`}>
          {display}
          <span className="ml-2 text-base text-lcd-dim">kWh</span>
        </p>
        <div className="mt-2 flex items-center justify-between text-2xs text-lcd-dim">
          <span className="mono">{meterId(u.identifier)}</span>
          <span>{u.balance <= 0 ? "No credit" : `~${duration(u.forecast.hoursRemaining)} left`}</span>
        </div>
      </div>
      </div>

      {last ? (
        <div className="mt-4">
          <p className="text-2xs text-fg-3">Last vend, {dayTime(last.at)}</p>
          <dl className="mt-1.5 grid grid-cols-3 gap-2 text-[13px]">
            <div>
              <dt className="text-2xs text-fg-3">Before</dt>
              <dd className="mono">{last.balanceBefore !== null ? quantity(last.balanceBefore, "kWh") : "n/a"}</dd>
            </div>
            <div>
              <dt className="text-2xs text-fg-3">Purchased</dt>
              <dd className="mono text-green">+{quantity(last.quantity, "kWh")}</dd>
            </div>
            <div>
              <dt className="text-2xs text-fg-3">After</dt>
              <dd className="mono">{last.balanceAfter !== null ? quantity(last.balanceAfter, "kWh") : "n/a"}</dd>
            </div>
          </dl>
          {last.demoToken && (
            <div className="mt-3 rounded-md border border-dashed border-fg/15 bg-bg px-3 py-2">
              <p className="text-2xs text-fg-3">Demo token for {naira(last.amountNgn)}. Not valid on any physical meter.</p>
              <p className="mono mt-0.5 text-[15px] tracking-[0.06em] text-fg">{last.demoToken}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-4 text-[13px] text-fg-3">No units bought through Borderless yet.</p>
      )}

      <div className="mt-4 border-t border-line-soft pt-3">
        <UsageStrip hourly={u.hourly} unit="kWh" label="Electricity consumption" />
      </div>
    </div>
  );
}
