import { BatteryMedium, MessageSquare, Signal } from "lucide-react";
import { clock, dayTime, duration, maskMsisdn, naira, NETWORK_NAMES, quantity } from "@/lib/format";
import { URGENCY, TONE_TEXT } from "@/lib/status";
import { cn, SimulatedTag } from "@/components/ui/primitives";
import type { UtilityView } from "@/server/views/household";
import { UsageStrip } from "./usage-strip";

/**
 * Virtual phone for the airtime or data line. Simulated device: the "network messages"
 * are generated from Borderless receipts, not sent by any real network.
 */
export function VirtualPhone({ u, simNow }: { u: UtilityView; simNow: string }) {
  const network = NETWORK_NAMES[u.network ?? ""] ?? "Network";
  const urgency = URGENCY[u.forecast.urgency]!;
  const isData = u.kind === "data";
  const freshId = u.lastPurchase && u.lastPurchase.at === simNow ? u.lastPurchase.id : null;

  const messages = u.history.slice(0, 3).map((h) => ({
    id: h.id,
    at: h.at,
    text: isData
      ? `Your ${h.label} bundle is now active. Data balance: ${h.balanceAfter !== null ? quantity(h.balanceAfter, "MB") : "updated"}.`
      : `You have received ${naira(h.quantity)} airtime. New balance: ${h.balanceAfter !== null ? naira(h.balanceAfter) : "updated"}.${h.reference ? ` Ref ${h.reference}.` : ""}`,
  }));

  return (
    <div className="rounded-lg bg-surface p-4 shadow-ring">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-semibold">{isData ? "Data line" : "Airtime line"}</p>
          <p className="text-2xs text-fg-3">{u.providerName}</p>
        </div>
        <SimulatedTag>Simulated device</SimulatedTag>
      </div>

      {/* Handset */}
      <div className="mx-auto mt-4 w-full max-w-[280px] rounded-[28px] bg-ink p-[7px] shadow-[0_10px_30px_-12px_rgb(12_13_12/0.35)]">
        <div className="overflow-hidden rounded-[22px] bg-raised">
          <div className="flex items-center justify-between px-4 pt-2.5 pb-1 text-2xs text-fg-2">
            <span className="mono">{clock(simNow)}</span>
            <span className="h-1.5 w-14 rounded-full bg-ink" aria-hidden />
            <span className="flex items-center gap-1">
              <span className="font-semibold">{network}</span>
              {isData && <span className="mono text-[10px]">4G</span>}
              <Signal className="size-3" aria-hidden />
              <BatteryMedium className="size-3.5" aria-hidden />
            </span>
          </div>

          <div className={cn("px-4 pt-4 pb-5 text-center", freshId && "animate-credit")}>
            <p className="text-2xs text-fg-3">{isData ? "Data balance" : "Airtime balance"}</p>
            <p className="mono mt-1 text-[32px] leading-none font-medium tracking-[-0.02em]">{quantity(u.balance, u.unit)}</p>
            <p className={cn("mt-1.5 text-2xs font-semibold", TONE_TEXT[urgency.tone])}>
              {u.balance <= 0 ? "Empty" : `${urgency.label}, ~${duration(u.forecast.hoursRemaining)} left`}
            </p>
            {isData && (
              <p className="mt-2 text-2xs text-fg-3">
                {u.activeBundle ? (
                  <>
                    {u.activeBundle}
                    {u.expiresAt && <>, expires {dayTime(u.expiresAt)}</>}
                  </>
                ) : (
                  "No active bundle"
                )}
              </p>
            )}
            <p className="mono mt-3 text-2xs text-fg-3">{maskMsisdn(u.identifier)}</p>
          </div>

          <div className="space-y-2 border-t border-line-soft bg-bg px-3 py-3">
            <p className="flex items-center gap-1.5 text-2xs text-fg-3">
              <MessageSquare className="size-3" aria-hidden /> Messages from {network} (simulated)
            </p>
            {messages.length ? (
              messages.map((m) => (
                <div key={m.id} className={cn("rounded-md rounded-tl-sm border border-line-soft bg-surface px-2.5 py-2", m.id === freshId && "border-green/40 animate-fade-in")}>
                  <p className="text-2xs leading-relaxed text-fg">{m.text}</p>
                  <p className="mono mt-1 text-[10px] text-fg-3">{dayTime(m.at)}</p>
                </div>
              ))
            ) : (
              <p className="py-2 text-2xs text-fg-3">No recharges yet.</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-line-soft pt-3">
        <UsageStrip hourly={u.hourly} unit={u.unit} label={isData ? "Data usage" : "Airtime usage"} />
      </div>
    </div>
  );
}
