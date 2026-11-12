import { clock, quantity } from "@/lib/format";

/** 24 hourly bars of simulated consumption. Quiet by design: it supports, it doesn't decorate. */
export function UsageStrip({ hourly, unit, label }: { hourly: { at: string; used: number }[]; unit: string; label: string }) {
  const max = Math.max(...hourly.map((h) => h.used), 0.0001);
  const total = hourly.reduce((t, h) => t + h.used, 0);
  return (
    <figure>
      <div className="flex h-10 items-end gap-[2px]" role="img" aria-label={`${label}: ${quantity(total, unit)} used in the last 24 hours`}>
        {hourly.map((h) => (
          <div
            key={h.at}
            title={`${clock(h.at)}: ${quantity(h.used, unit, { precise: true })}`}
            className="flex-1 rounded-[1px] bg-fg-3/45"
            style={{ height: `${Math.max(4, (h.used / max) * 100)}%` }}
          />
        ))}
      </div>
      <figcaption className="mt-1.5 flex justify-between text-2xs text-fg-3">
        <span>24 h ago</span>
        <span className="mono">{quantity(total, unit)} used</span>
        <span>Now</span>
      </figcaption>
    </figure>
  );
}
