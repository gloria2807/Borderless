/**
 * Consumption forecasting. Pure functions over simulated usage history.
 *
 * Terminology the agent relies on (and must keep distinct in language):
 *  - FACT        the current device balance (read from the virtual device)
 *  - OBSERVATION the measured recent consumption rate
 *  - PREDICTION  time to depletion extrapolated from that rate
 */
import type { UtilityKind } from "../db/schema";
import type { Unit } from "../providers/types";

const HOUR = 3_600_000;

/** How far back the "recent" consumption rate looks. */
export const RECENT_WINDOW_HOURS = 6;
/** Recent use at or above this multiple of the household's usual rate is flagged as unusual. */
export const ANOMALY_RATIO = 2;
/** Minimum samples in the window before we trust the observed rate over the baseline. */
const MIN_SAMPLES = 3;

export interface UsageSample {
  simTime: Date;
  /** Positive = consumed. */
  delta: number;
}

export interface UtilityReading {
  kind: UtilityKind;
  balance: number;
  unit: Unit;
  baselinePerHour: number;
  expiresAt: Date | null;
}

export type UrgencyLevel = "critical" | "low" | "watch" | "ok";

export interface Forecast {
  kind: UtilityKind;
  balance: number;
  unit: Unit;
  /** Consumption per hour actually used for the prediction. */
  ratePerHour: number;
  rateSource: "observed" | "baseline";
  baselinePerHour: number;
  /** Ratio of recent use to the usual rate (1 = normal). */
  usageRatio: number;
  unusualUsage: boolean;
  /** Hours until the balance runs out at the current rate (Infinity if no consumption). */
  hoursToDepletion: number;
  /** Data bundles: hours until the bundle expires. */
  hoursToExpiry: number | null;
  /** Effective hours of service left: min(depletion, expiry). */
  hoursRemaining: number;
  limitedBy: "depletion" | "expiry" | "none";
  depletesAt: Date | null;
  urgency: UrgencyLevel;
  /** How far the prediction can be trusted, from how much and how steady the history is. */
  confidence: ForecastConfidence;
  /** The usage history the forecast actually considered. */
  history: { windowHours: number; readingsInWindow: number; readingsLast24h: number; usedLast24h: number };
  /** Plain-language assumptions behind the prediction. */
  assumptions: string[];
}

export interface ForecastConfidence {
  level: "high" | "medium" | "low";
  basis: string;
}

/** Window readings that vary less than this (coefficient of variation) count as steady. */
const STEADY_CV = 0.35;

export function confidenceFor(windowDeltas: number[], rateSource: "observed" | "baseline", unusualUsage: boolean, readingsLast24h: number): ForecastConfidence {
  if (rateSource === "baseline") return { level: "low", basis: "Too little recent usage history; using the household's usual rate." };
  const xs = windowDeltas.filter((d) => d > 0);
  const mean = xs.reduce((t, x) => t + x, 0) / Math.max(1, xs.length);
  const sd = Math.sqrt(xs.reduce((t, x) => t + (x - mean) ** 2, 0) / Math.max(1, xs.length));
  const cv = mean > 0 ? sd / mean : 1;
  const variation = `variation ${Math.round(cv * 100)}%`;
  if (unusualUsage) return { level: "medium", basis: `Usage changed recently (${xs.length} readings, ${variation}); the new rate may not last.` };
  if (xs.length >= RECENT_WINDOW_HOURS && cv < STEADY_CV && readingsLast24h >= 12) {
    return { level: "high", basis: `${xs.length} recent hourly readings of steady use (${variation}), ${readingsLast24h} readings in the last 24 hours.` };
  }
  return { level: "medium", basis: `${xs.length} recent hourly readings, ${variation}.` };
}

/** Urgency thresholds, in hours of service remaining. */
export const URGENCY_HOURS = { critical: 12, low: 36, watch: 72 } as const;

export function urgencyFor(hoursRemaining: number, balance: number): UrgencyLevel {
  if (balance <= 0 || hoursRemaining < URGENCY_HOURS.critical) return "critical";
  if (hoursRemaining < URGENCY_HOURS.low) return "low";
  if (hoursRemaining < URGENCY_HOURS.watch) return "watch";
  return "ok";
}

export function observedRate(samples: UsageSample[], now: Date, windowHours = RECENT_WINDOW_HOURS): { rate: number; count: number } {
  const from = now.getTime() - windowHours * HOUR;
  const recent = samples.filter((s) => s.delta > 0 && s.simTime.getTime() > from && s.simTime.getTime() <= now.getTime());
  if (recent.length === 0) return { rate: 0, count: 0 };
  const total = recent.reduce((t, s) => t + s.delta, 0);
  // Samples are hourly; divide by the span they cover, not by the full window, so a
  // freshly seeded or just-reset household is not under-estimated.
  return { rate: total / Math.min(windowHours, recent.length), count: recent.length };
}

export function forecast(reading: UtilityReading, samples: UsageSample[], now: Date): Forecast {
  const observed = observedRate(samples, now);
  const useObserved = observed.count >= MIN_SAMPLES && observed.rate > 0;
  const ratePerHour = useObserved ? observed.rate : reading.baselinePerHour;
  const usageRatio = reading.baselinePerHour > 0 && useObserved ? observed.rate / reading.baselinePerHour : 1;

  const hoursToDepletion = ratePerHour > 0 ? Math.max(0, reading.balance) / ratePerHour : Number.POSITIVE_INFINITY;
  const hoursToExpiry = reading.expiresAt ? Math.max(0, (reading.expiresAt.getTime() - now.getTime()) / HOUR) : null;
  const hoursRemaining = hoursToExpiry === null ? hoursToDepletion : Math.min(hoursToDepletion, hoursToExpiry);
  const limitedBy: Forecast["limitedBy"] = !Number.isFinite(hoursRemaining)
    ? "none"
    : hoursToExpiry !== null && hoursToExpiry < hoursToDepletion
      ? "expiry"
      : "depletion";

  const t = now.getTime();
  const windowDeltas = samples.filter((x) => x.delta > 0 && x.simTime.getTime() > t - RECENT_WINDOW_HOURS * HOUR && x.simTime.getTime() <= t).map((x) => x.delta);
  const last24 = samples.filter((x) => x.delta > 0 && x.simTime.getTime() > t - 24 * HOUR && x.simTime.getTime() <= t);
  const unusualUsage = useObserved && usageRatio >= ANOMALY_RATIO;
  const assumptions = [
    useObserved
      ? `Use continues at the rate observed over the last ${RECENT_WINDOW_HOURS} hours.`
      : "Use follows the household's usual rate (not enough recent readings).",
  ];
  if (hoursToExpiry !== null) assumptions.push("Any data left when the bundle expires is forfeited.");
  if (unusualUsage) assumptions.push("Recent use is well above normal; if it returns to normal the balance lasts longer.");
  assumptions.push("Usage is simulated for this demo household.");

  return {
    kind: reading.kind,
    balance: reading.balance,
    unit: reading.unit,
    ratePerHour,
    rateSource: useObserved ? "observed" : "baseline",
    baselinePerHour: reading.baselinePerHour,
    usageRatio,
    unusualUsage,
    hoursToDepletion,
    hoursToExpiry,
    hoursRemaining,
    limitedBy,
    depletesAt: Number.isFinite(hoursRemaining) ? new Date(now.getTime() + hoursRemaining * HOUR) : null,
    urgency: urgencyFor(hoursRemaining, reading.balance),
    confidence: confidenceFor(windowDeltas, useObserved ? "observed" : "baseline", unusualUsage, last24.length),
    history: {
      windowHours: RECENT_WINDOW_HOURS,
      readingsInWindow: windowDeltas.length,
      readingsLast24h: last24.length,
      usedLast24h: Math.round(last24.reduce((sum, x) => sum + x.delta, 0) * 100) / 100,
    },
    assumptions,
  };
}
