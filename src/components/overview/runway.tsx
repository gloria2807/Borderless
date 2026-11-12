import { dayTime, duration, quantity, UTILITY_NAMES } from "@/lib/format";
import { URGENCY, TONE_BG, TONE_TEXT } from "@/lib/status";
import { cn } from "@/components/ui/primitives";
import type { PurchaseRowView, UtilityView } from "@/server/views/household";

const HORIZON_H = 7 * 24;
const LOW_H = 36;
const HOUR = 3_600_000;
const DAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Africa/Lagos" });

/**
 * The service runway: every utility on one shared 7-day axis starting now.
 * Bar length = predicted hours of service left. Answers "what runs out first, and when?"
 */
export function Runway({ utilities, simNow, inFlight }: { utilities: UtilityView[]; simNow: string; inFlight: PurchaseRowView[] }) {
  const now = new Date(simNow).getTime();
  // Day ticks at local midnight boundaries within the horizon.
  const ticks: { pct: number; label: string }[] = [];
  const firstMidnight = Math.ceil((now + HOUR) / (24 * HOUR)) * 24 * HOUR - HOUR; // WAT midnight = 23:00Z
  for (let t = firstMidnight; t < now + HORIZON_H * HOUR; t += 24 * HOUR) {
    const pct = ((t - now) / (HORIZON_H * HOUR)) * 100;
    // Skip a label that would collide with "Now" or run off the right edge.
    if (pct < 9 || pct > 97) continue;
    ticks.push({ pct, label: DAY_FMT.format(new Date(t + HOUR)) });
  }
  const lowPct = (LOW_H / HORIZON_H) * 100;

  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-y-5 sm:grid-cols-[148px_minmax(0,1fr)] sm:gap-x-5">
        {/* Axis */}
        <div className="hidden sm:block" />
        <div className="relative h-4 text-2xs text-fg-3" aria-hidden>
          <span className="absolute left-0">Now</span>
          {ticks.map((t) => (
            // On narrow screens the first day label can sit on top of "Now"; drop it there.
            <span key={t.pct} className={cn("absolute -translate-x-1/2", t.pct < 16 && "max-sm:hidden")} style={{ left: `${t.pct}%` }}>
              {t.label}
            </span>
          ))}
        </div>

        {utilities.map((u) => {
          const f = u.forecast;
          const hours = f.hoursRemaining;
          const pct = hours === null ? 100 : Math.min(100, (hours / HORIZON_H) * 100);
          const tone = URGENCY[f.urgency]!.tone;
          const barTone = f.urgency === "watch" ? "bg-fg-3" : TONE_BG[tone];
          const buying = inFlight.find((p) => p.kind === u.kind);
          const beyond = hours === null || hours > HORIZON_H;
          const endText =
            f.balance <= 0 ? "Out now" : beyond ? "Lasts beyond 7 days" : `${f.limitedBy === "expiry" ? "Bundle expires" : "Runs out"} ~${dayTime(f.depletesAt!)}`;

          return (
            <div key={u.kind} className="contents">
              <div className="flex items-baseline justify-between gap-3 sm:block">
                <p className="text-[13px] font-semibold text-fg">{UTILITY_NAMES[u.kind]}</p>
                <p className="mono text-[13px] text-fg-2">
                  {quantity(u.balance, u.unit)}
                  <span className={cn("ml-2 font-sans text-2xs font-semibold", TONE_TEXT[tone])}>{duration(hours)}</span>
                </p>
              </div>
              <div className="relative -mt-3 h-9 sm:mt-0">
                {/* Track, with the "running low" zone tinted */}
                <div className="absolute inset-x-0 top-3 h-3 rounded-sm bg-line-soft" />
                <div className="absolute top-3 left-0 h-3 rounded-l-sm bg-amber/[0.07]" style={{ width: `${lowPct}%` }} aria-hidden />
                {ticks.map((t) => (
                  <div key={t.pct} aria-hidden className="absolute top-2 h-5 w-px bg-line" style={{ left: `${t.pct}%` }} />
                ))}
                <div
                  role="img"
                  aria-label={`${UTILITY_NAMES[u.kind]}: ${endText.toLowerCase()}, ${URGENCY[f.urgency]!.label.toLowerCase()}`}
                  className={cn("absolute top-3 left-0 h-3 rounded-sm transition-[width] duration-700", barTone)}
                  style={{ width: `${Math.max(pct, 0.8)}%` }}
                />
                <p
                  className={cn("absolute top-[26px] text-2xs whitespace-nowrap", pct > 60 ? "-translate-x-full" : "", TONE_TEXT[tone])}
                  style={{ left: `${Math.max(pct, 0.8)}%` }}
                >
                  {endText}
                  {buying && <span className="ml-2 text-fg-2">Buying {buying.label} now</span>}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-6 text-2xs text-fg-3">
        Predictions from the last 6 hours of simulated usage. The tinted zone marks the last 36 hours, when Borderless considers a utility to be running low.
      </p>
    </div>
  );
}
