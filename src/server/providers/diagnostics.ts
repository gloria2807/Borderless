/**
 * Demo meter-diagnostic providers — paid INFORMATION services (procurement amendment A2).
 *
 * SIMULATED. A diagnostic provider has access to the smart meter's circuit-level
 * telemetry, which the household's free view (hourly meter totals) does not show. Here the
 * telemetry is simulated from the meter's real hourly readings plus a provider-side ground
 * truth (`meter_profiles`). The report is released only after an x402 payment settles,
 * through the same seller, settlement ledger and receipts as utility purchases.
 *
 * The agent cannot read `meter_profiles` or call `deliver`: the only way to learn what is
 * drawing power is to pay a provider for a report.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import * as s from "../db/schema";
import type { MeterProfile } from "../db/schema";
import { naira, ProductError, round, type DeliveryContext, type Product, type ProviderModule } from "./types";

/** Circuit split of the household's NORMAL electricity use (demo values). */
const NORMAL_SPLIT = { lighting: 0.2, kitchen: 0.3, cooling: 0.35, water_heater: 0.15 } as const;
type Circuit = keyof typeof NORMAL_SPLIT;
const CIRCUIT_NAME: Record<Circuit, string> = { lighting: "Lighting", kitchen: "Kitchen", cooling: "Cooling and fans", water_heater: "Water heater" };

export const DIAGNOSTIC_SLUG = "meter-diagnostic";
export const diagnosticPath = (providerId: string) => `/api/services/${providerId}/${DIAGNOSTIC_SLUG}`;

export interface DiagnosticConfig {
  id: string;
  name: string;
  payToEnv: string;
  priceNgn: number;
  /** "basic": finding and recommendation. "detailed": also circuit-level evidence. */
  detail: "basic" | "detailed";
  offerSummary: string;
}

export type DiagnosticFinding = "stuck_load" | "extra_occupancy" | "meter_overreading" | "normal" | "insufficient_data";

export interface DiagnosticReport {
  service: "meter_diagnostic";
  provider: string;
  detail: "basic" | "detailed";
  finding: DiagnosticFinding;
  summary: string;
  confidence: "high" | "medium";
  /** The usage rate the household should expect once the cause is dealt with (kWh per hour). */
  expectedNormalKwhPerHour: number;
  observedKwhPerHour: number;
  /** Electricity being lost to the cause, per day (kWh). Zero for genuine extra use. */
  avoidableKwhPerDay: number;
  /** What this means for buying electricity now. */
  purchasingAdvice: string;
  /** What the owner should do. */
  ownerAction: string | null;
  evidence: string[];
  circuits?: { circuit: string; observedKw: number; normalKw: number }[];
  window: { hours: number; readings: number };
  simulated: true;
}

const FINDING_TEXT: Record<Exclude<DiagnosticFinding, "insufficient_data">, { summary: string; advice: string; owner: string | null }> = {
  stuck_load: {
    summary: "The water heater circuit is drawing power continuously, including overnight when it would normally be off. It appears to be stuck on.",
    advice: "Most of the extra use is avoidable. Buying for the current rate would over-buy: buy only what is needed at the normal rate, and only if the meter would otherwise run out soon.",
    owner: "Switch off or repair the water heater (check its thermostat).",
  },
  extra_occupancy: {
    summary: "Kitchen, cooling and lighting circuits are all busier during the day and evening, with normal overnight use. This matches more people in the home, not a fault.",
    advice: "The higher use is genuine. Size electricity purchases for the current, higher rate.",
    owner: null,
  },
  meter_overreading: {
    summary: "The meter is registering noticeably more energy than the circuits are drawing. The appliances look normal; the meter itself may be over-reading.",
    advice: "The household is not actually using more. Avoid buying extra on the strength of the meter's rate; buy only what is needed at the normal rate.",
    owner: "Report a possible faulty meter to the electricity company.",
  },
  normal: {
    summary: "Circuit loads match the household's normal pattern. No fault found.",
    advice: "Usage is normal; plan purchases on the observed rate.",
    owner: null,
  },
};

export function createDiagnosticProvider(cfg: DiagnosticConfig): ProviderModule {
  const product: Product = {
    code: "meter_diagnostic",
    providerId: cfg.id,
    kind: "electricity",
    label: `Meter diagnostic (${cfg.name.replace(/^Demo /, "")})`,
    amountNgn: cfg.priceNgn,
    quantity: 1,
    unit: "report",
  };

  return {
    definition: {
      id: cfg.id,
      category: "intelligence",
      kind: "electricity",
      name: cfg.name,
      countryCode: "NG",
      networks: [],
      minAmountNgn: cfg.priceNgn,
      maxAmountNgn: cfg.priceNgn,
      unit: "report",
      payToEnv: cfg.payToEnv,
      offerSummary: cfg.offerSummary,
    },
    service: {
      slug: DIAGNOSTIC_SLUG,
      title: "Meter diagnostic",
      releases: cfg.detail === "detailed" ? "A meter diagnostic report with circuit-level evidence" : "A meter diagnostic report (finding and recommendation)",
    },
    validateOrder: () => null,
    resolveProduct(order) {
      if (order.productCode !== undefined && order.productCode !== product.code) throw new ProductError("unknown_product", `${cfg.name} sells only "${product.code}".`);
      if (order.amountNgn !== undefined && order.amountNgn !== product.amountNgn) throw new ProductError("invalid_amount", `${cfg.name}'s diagnostic costs ${naira(product.amountNgn)}.`);
      return product;
    },
    listProducts: () => [product],
    fulfil: () => {
      throw new Error("Diagnostic providers release a report, not utility credit.");
    },
    async deliver(ctx: DeliveryContext) {
      return buildReport(ctx, cfg);
    },
  };
}

async function buildReport(ctx: DeliveryContext, cfg: DiagnosticConfig): Promise<DiagnosticReport & Record<string, unknown>> {
  const WINDOW = 8;
  const since = new Date(ctx.simNow.getTime() - WINDOW * 3_600_000);
  const [balance] = await ctx.tx.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, ctx.accountId));
  const readings = await ctx.tx
    .select({ delta: s.usageRecords.delta, simTime: s.usageRecords.simTime })
    .from(s.usageRecords)
    .where(and(eq(s.usageRecords.accountId, ctx.accountId), gt(s.usageRecords.simTime, since)))
    .orderBy(desc(s.usageRecords.simTime));
  const consumption = readings.filter((r) => r.delta > 0);
  const [profileRow] = await ctx.tx.select().from(s.meterProfiles).where(eq(s.meterProfiles.accountId, ctx.accountId));
  const normal = balance?.baselineUsagePerHour ?? 0;
  const observed = consumption.length ? consumption.reduce((t, r) => t + r.delta, 0) / consumption.length : 0;
  const base = { service: "meter_diagnostic" as const, provider: cfg.name, detail: cfg.detail, window: { hours: WINDOW, readings: consumption.length }, simulated: true as const };

  if (consumption.length < 3) {
    return {
      ...base,
      finding: "insufficient_data",
      summary: "Not enough recent meter readings to diagnose.",
      confidence: "medium",
      expectedNormalKwhPerHour: round(normal, 3),
      observedKwhPerHour: round(observed, 3),
      avoidableKwhPerDay: 0,
      purchasingAdvice: "Plan on the household's usual rate.",
      ownerAction: null,
      evidence: [],
    };
  }

  const profile: MeterProfile | null = profileRow?.profile ?? null;
  const finding: DiagnosticFinding = profile === "stuck_water_heater" ? "stuck_load" : profile === "extra_occupancy" ? "extra_occupancy" : profile === "meter_overreading" ? "meter_overreading" : "normal";
  const text = FINDING_TEXT[finding as Exclude<DiagnosticFinding, "insufficient_data">];
  const extra = Math.max(0, observed - normal);

  // Simulated circuit telemetry: normal split of the usual rate, plus where the extra goes.
  const circuits = (Object.keys(NORMAL_SPLIT) as Circuit[]).map((c) => {
    const normalKw = normal * NORMAL_SPLIT[c];
    let observedKw = normalKw;
    if (finding === "stuck_load" && c === "water_heater") observedKw = normalKw + extra;
    if (finding === "extra_occupancy" && c !== "water_heater") observedKw = normalKw + extra * (NORMAL_SPLIT[c] / (1 - NORMAL_SPLIT.water_heater));
    if (finding === "normal") observedKw = observed * NORMAL_SPLIT[c];
    return { circuit: CIRCUIT_NAME[c], observedKw: round(observedKw, 3), normalKw: round(normalKw, 3) };
  });

  const expectedNormal = finding === "extra_occupancy" || finding === "normal" ? observed : normal;
  const avoidablePerDay = finding === "stuck_load" || finding === "meter_overreading" ? extra * 24 : 0;
  const evidence =
    finding === "stuck_load"
      ? [`Water heater circuit averaged ${round(normal * NORMAL_SPLIT.water_heater + extra, 2)} kW over the last ${WINDOW} hours (normally about ${round(normal * NORMAL_SPLIT.water_heater, 2)} kW).`, "The load did not drop overnight.", `Other circuits are within their normal range.`]
      : finding === "extra_occupancy"
        ? ["Kitchen, cooling and lighting each rose in proportion during the day and evening.", "Overnight use is normal.", "No single circuit shows a continuous fault-like load."]
        : finding === "meter_overreading"
          ? [`Circuits sum to about ${round(normal, 2)} kWh per hour, but the meter registered ${round(observed, 2)}.`, `That is ${Math.round((observed / Math.max(normal, 0.001) - 1) * 100)}% more than the appliances drew.`]
          : ["Every circuit is within its normal range."];

  return {
    ...base,
    finding,
    summary: text.summary,
    confidence: cfg.detail === "detailed" ? "high" : "medium",
    expectedNormalKwhPerHour: round(expectedNormal, 3),
    observedKwhPerHour: round(observed, 3),
    avoidableKwhPerDay: round(avoidablePerDay, 2),
    purchasingAdvice: text.advice,
    ownerAction: text.owner,
    evidence: cfg.detail === "detailed" ? evidence : evidence.slice(0, 1),
    ...(cfg.detail === "detailed" ? { circuits } : {}),
  };
}

export const gridSenseDiagnostics = createDiagnosticProvider({
  id: "prv_demo_gridsense",
  name: "Demo GridSense Diagnostics",
  payToEnv: "PROVIDER_GRIDSENSE_PAYTO",
  priceNgn: 300,
  detail: "basic",
  offerSummary: "Quick meter check from smart-meter telemetry: the likely cause of unusual use and what to do. ₦300 per report.",
});

export const meterLabDiagnostics = createDiagnosticProvider({
  id: "prv_demo_meterlab",
  name: "Demo MeterLab",
  payToEnv: "PROVIDER_METERLAB_PAYTO",
  priceNgn: 800,
  detail: "detailed",
  offerSummary: "Detailed meter diagnostic with circuit-by-circuit evidence and higher confidence. ₦800 per report.",
});
