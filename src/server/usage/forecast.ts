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

  return {
    kind: reading.kind,
    balance: reading.balance,
    unit: reading.unit,
    ratePerHour,
    rateSource: useObserved ? "observed" : "baseline",
    baselinePerHour: reading.baselinePerHour,
    usageRatio,
    unusualUsage: useObserved && usageRatio >= ANOMALY_RATIO,
    hoursToDepletion,
    hoursToExpiry,
    hoursRemaining,
    limitedBy,
    depletesAt: Number.isFinite(hoursRemaining) ? new Date(now.getTime() + hoursRemaining * HOUR) : null,
    urgency: urgencyFor(hoursRemaining, reading.balance),
  };
}
