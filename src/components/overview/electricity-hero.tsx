import Link from "next/link";
import { ArrowRight, BatteryCharging } from "lucide-react";
import { SimulatedTag, StatusPill } from "@/components/ui/primitives";
import { UsageStrip } from "@/components/devices/usage-strip";
import { dayTime, duration, meterId, naira, quantity } from "@/lib/format";
import { URGENCY } from "@/lib/status";
import type { UtilityView } from "@/server/views/household";

/** The primary utility of the live demo, shown with everything the owner needs at a glance. */
export function ElectricityHero({ u, distributionCompany, actions }: { u: UtilityView; distributionCompany: string | null; actions?: React.ReactNode }) {
  const f = u.forecast;
  const urgency = URGENCY[f.urgency]!;
  const last = u.lastPurchase;
  return (
    <section aria-labelledby="electricity-title" className="rounded-lg bg-surface shadow-ring">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-md bg-bg-2">
            <BatteryCharging className="size-4 text-fg-2" aria-hidden />
          </span>
          <div>
            <h2 id="electricity-title" className="text-[13.5px] font-semibold">
              Electricity
            </h2>
            <p className="mono text-[10.5px] text-fg-3">
              Meter {meterId(u.identifier)} · {distributionCompany ?? "DisCo unknown"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SimulatedTag>Simulated meter</SimulatedTag>
          <StatusPill tone={urgency.tone} pulse={false}>
            {urgency.label}
          </StatusPill>
        </div>
      </header>
      <div className="grid gap-5 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div>
          <p className="text-[11.5px] text-fg-3">Units on the meter</p>
          <p className="mt-1 text-[40px] leading-none font-semibold tracking-[-0.045em] tabular">
            {u.balance.toFixed(1)}
            <span className="ml-1.5 text-[15px] font-normal tracking-normal text-fg-3">kWh</span>
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
            <div>
              <dt className="text-[11px] text-fg-3">Estimated time left</dt>
              <dd className="font-medium tabular">{f.balance <= 0 ? "Out" : duration(f.hoursRemaining)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-fg-3">Runs out</dt>
              <dd className="tabular">{f.depletesAt && f.balance > 0 ? `~${dayTime(f.depletesAt)}` : f.balance <= 0 ? "Now" : "Beyond 7 days"}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-fg-3">Used, last 24 h</dt>
              <dd className="tabular">{quantity(u.usedLast24h, "kWh")}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-fg-3">Latest purchase</dt>
              <dd className="tabular">
                {last ? (
                  <Link href={`/transactions/${last.id}`} className="hover:underline">
                    {naira(last.amountNgn)} · +{quantity(last.quantity, "kWh")}
                  </Link>
                ) : (
                  <span className="text-fg-3">None yet</span>
                )}
              </dd>
            </div>
          </dl>
          {actions && <div className="mt-5 flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        <div className="flex flex-col justify-between gap-3">
          <UsageStrip hourly={u.hourly} unit="kWh" label="Electricity consumption, last 24 hours" />
          <Link href="/household#electricity" className="inline-flex items-center gap-1 self-end text-[12.5px] font-medium text-fg-2 hover:text-fg">
            Meter and purchase history <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}
