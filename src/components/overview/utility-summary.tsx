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
      className="group block rounded-lg border border-line bg-surface p-4 transition-colors hover:border-fg-3/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-fg-3" aria-hidden />
          <span className="text-[13px] font-semibold">{UTILITY_NAMES[u.kind]}</span>
        </div>
        <StatusPill tone={urgency.tone} pulse={false}>
          {urgency.label}
        </StatusPill>
      </div>

      <p className="mono mt-4 text-2xl leading-none font-medium tracking-[-0.02em]">{quantity(u.balance, u.unit)}</p>
      <p className="mt-1.5 text-[13px] text-fg-3">{recipient}</p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
        <div>
          <dt className="text-2xs text-fg-3">Estimated time left</dt>
          <dd className="mono text-fg">{f.balance <= 0 ? "Out" : duration(f.hoursRemaining)}</dd>
        </div>
        <div>
          <dt className="text-2xs text-fg-3">Used, last 24 h</dt>
          <dd className="mono text-fg">{u.kind === "airtime" ? naira(u.usedLast24h) : quantity(u.usedLast24h, u.unit)}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-2xs text-fg-3">Last purchase</dt>
          <dd className="text-fg">
            {u.lastPurchase ? (
              <>
                <span className="mono">{naira(u.lastPurchase.amountNgn)}</span>
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
