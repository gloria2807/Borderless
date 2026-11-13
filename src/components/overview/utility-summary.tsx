import Link from "next/link";
import { BatteryCharging, Phone, Wifi } from "lucide-react";
import { dayTime, duration, maskMsisdn, meterId, naira, NETWORK_NAMES, quantity, UTILITY_NAMES } from "@/lib/format";
import { URGENCY } from "@/lib/status";
import { StatusPill } from "@/components/ui/primitives";
import type { UtilityView } from "@/server/views/household";

const ICONS = { electricity: BatteryCharging, airtime: Phone, data: Wifi } as const;

export function UtilitySummary({ u }: { u: UtilityView }) {
  const Icon = ICONS[u.kind];
  const f = u.forecast;
  const urgency = URGENCY[f.urgency]!;
  const recipient = u.kind === "electricity" ? `Meter ${meterId(u.identifier)}` : `${NETWORK_NAMES[u.network ?? ""] ?? ""} ${maskMsisdn(u.identifier)}`;

  return (
    <Link
      href={`/household#${u.kind}`}
      className="group block rounded-lg bg-surface p-4 shadow-ring transition-shadow duration-150 hover:shadow-[0_0_0_1px_rgb(12_13_12/0.14),0_4px_14px_-6px_rgb(12_13_12/0.14)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-bg-2"><Icon className="size-3.5 text-fg-2" aria-hidden /></span>
          <span className="text-[13px] font-medium">{UTILITY_NAMES[u.kind]}</span>
        </div>
        <StatusPill tone={urgency.tone} pulse={false}>
          {urgency.label}
        </StatusPill>
      </div>

      <p className="mt-4 text-[26px] leading-none font-semibold tracking-[-0.035em] tabular">{quantity(u.balance, u.unit)}</p>
      <p className="mono mt-2 text-[11px] text-fg-3">{recipient}</p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-line-soft pt-3 text-[13px]">
        <div>
          <dt className="text-2xs text-fg-3">Estimated time left</dt>
          <dd className="text-fg tabular">{f.balance <= 0 ? "Out" : duration(f.hoursRemaining)}</dd>
        </div>
        <div>
          <dt className="text-2xs text-fg-3">Used, last 24 h</dt>
          <dd className="text-fg tabular">{u.kind === "airtime" ? naira(u.usedLast24h) : quantity(u.usedLast24h, u.unit)}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-2xs text-fg-3">Last purchase</dt>
          <dd className="text-fg">
            {u.lastPurchase ? (
              <>
                <span className="tabular">{naira(u.lastPurchase.amountNgn)}</span>
                <span className="text-fg-3"> on {dayTime(u.lastPurchase.at)}</span>
              </>
            ) : (
              <span className="text-fg-3">None yet</span>
            )}
          </dd>
        </div>
      </dl>
      {u.kind === "data" && u.activeBundle && (
        <p className="mt-3 border-t border-line-soft pt-2.5 text-2xs text-fg-3">
          Bundle: {u.activeBundle}
          {u.expiresAt && <>, expires {dayTime(u.expiresAt)}</>}
        </p>
      )}
      {f.unusualUsage && <p className="mt-3 border-t border-line-soft pt-2.5 text-2xs text-amber">Using {f.usageRatio.toFixed(1)}× the usual rate</p>}
    </Link>
  );
}
