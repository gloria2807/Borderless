import { describe, expect, it } from "vitest";
import { forecast, observedRate, urgencyFor, type UsageSample } from "./forecast";
import { hourlyConsumption, localHour } from "./simulator";

const NOW = new Date("2026-11-14T06:00:00Z");
const HOUR = 3_600_000;
const samples = (rates: number[]): UsageSample[] => rates.map((delta, i) => ({ simTime: new Date(NOW.getTime() - i * HOUR), delta }));
const reading = { kind: "electricity" as const, balance: 8, unit: "kWh" as const, baselinePerHour: 0.32, expiresAt: null };

describe("forecast", () => {
  it("uses the observed recent rate when there is enough history", () => {
    const f = forecast(reading, samples([0.4, 0.4, 0.4, 0.4]), NOW);
    expect(f.rateSource).toBe("observed");
    expect(f.ratePerHour).toBeCloseTo(0.4);
    expect(f.hoursToDepletion).toBeCloseTo(20);
    expect(f.depletesAt?.getTime()).toBe(NOW.getTime() + 20 * HOUR);
  });
  it("falls back to the baseline with too little history", () => {
    const f = forecast(reading, samples([5]), NOW);
    expect(f.rateSource).toBe("baseline");
    expect(f.ratePerHour).toBe(0.32);
    expect(f.unusualUsage).toBe(false);
  });
  it("ignores credits (negative deltas) and samples outside the window", () => {
    const s = [...samples([0.3, 0.3, 0.3]), { simTime: new Date(NOW.getTime() - HOUR / 2), delta: -20 }, { simTime: new Date(NOW.getTime() - 10 * HOUR), delta: 9 }];
    expect(observedRate(s, NOW).rate).toBeCloseTo(0.3);
  });
  it("flags usage at or above twice the usual rate", () => {
    const f = forecast({ ...reading, kind: "data", unit: "MB", baselinePerHour: 22, balance: 300 }, samples([50, 50, 50, 50]), NOW);
    expect(f.unusualUsage).toBe(true);
    expect(f.usageRatio).toBeCloseTo(50 / 22);
  });
  it("is limited by bundle expiry when that comes first", () => {
    const f = forecast({ ...reading, kind: "data", unit: "MB", baselinePerHour: 22, balance: 5_000, expiresAt: new Date(NOW.getTime() + 3 * HOUR) }, [], NOW);
    expect(f.limitedBy).toBe("expiry");
    expect(f.hoursRemaining).toBeCloseTo(3);
    expect(f.urgency).toBe("critical");
  });
  it("treats an empty device as critical and zero consumption as no depletion", () => {
    expect(forecast({ ...reading, balance: 0 }, [], NOW).urgency).toBe("critical");
    expect(forecast({ ...reading, baselinePerHour: 0 }, [], NOW).hoursRemaining).toBe(Number.POSITIVE_INFINITY);
  });
  it("maps hours remaining to urgency levels", () => {
    expect(urgencyFor(5, 1)).toBe("critical");
    expect(urgencyFor(20, 1)).toBe("low");
    expect(urgencyFor(50, 1)).toBe("watch");
    expect(urgencyFor(100, 1)).toBe("ok");
  });
});

describe("simulator profile", () => {
  it("uses West Africa Time for the daily profile", () => {
    expect(localHour(new Date("2026-11-14T18:00:00Z"))).toBe(19);
  });
  it("peaks electricity in the evening and data in the daytime", () => {
    const evening = hourlyConsumption("electricity", 1, 1, new Date("2026-11-14T18:00:00Z"));
    const night = hourlyConsumption("electricity", 1, 1, new Date("2026-11-14T02:00:00Z"));
    expect(evening).toBeGreaterThan(night);
    expect(hourlyConsumption("data", 10, 3, new Date("2026-11-14T12:00:00Z"))).toBeCloseTo(36);
  });
  it("averages close to the baseline over a full day", () => {
    for (const kind of ["electricity", "data", "airtime"] as const) {
      let total = 0;
      for (let h = 0; h < 24; h += 1) total += hourlyConsumption(kind, 1, 1, new Date(Date.UTC(2026, 10, 14, h)));
      expect(total / 24).toBeGreaterThan(0.95);
      expect(total / 24).toBeLessThan(1.05);
    }
  });
});
