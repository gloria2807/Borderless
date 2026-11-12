/**
 * Demo provider catalogue. All tariffs and bundles are DEMONSTRATION VALUES —
 * they are not real DisCo tariffs or mobile network prices.
 *
 * Providers are keyed by id so a real provider (other country, other DisCo,
 * real VTU API) can be added without touching the agent or payment layers.
 */
import type { MobileNetwork, UtilityKind } from "../db/schema";

export type Unit = "kWh" | "NGN" | "MB";

export interface Product {
  code: string;
  kind: UtilityKind;
  label: string;
  amountNgn: number;
  quantity: number;
  unit: Unit;
  /** Data bundles only. */
  validityHours?: number;
}

export interface ProviderDefinition {
  id: string;
  kind: UtilityKind;
  name: string;
  countryCode: string;
  networks: MobileNetwork[];
  minAmountNgn: number;
  maxAmountNgn: number;
  unit: Unit;
}

export const PROVIDERS: Record<UtilityKind, ProviderDefinition> = {
  electricity: {
    id: "prv_demo_electricity",
    kind: "electricity",
    name: "Demo Prepaid Electricity",
    countryCode: "NG",
    networks: [],
    minAmountNgn: 1_000,
    maxAmountNgn: 20_000,
    unit: "kWh",
  },
  airtime: {
    id: "prv_demo_airtime",
    kind: "airtime",
    name: "Demo Airtime Gateway",
    countryCode: "NG",
    networks: ["mtn", "airtel", "glo", "t2"],
    minAmountNgn: 100,
    maxAmountNgn: 10_000,
    unit: "NGN",
  },
  data: {
    id: "prv_demo_data",
    kind: "data",
    name: "Demo Data Gateway",
    countryCode: "NG",
    networks: ["mtn", "airtel", "glo", "t2"],
    minAmountNgn: 500,
    maxAmountNgn: 10_000,
    unit: "MB",
  },
};

export function providerById(id: string): ProviderDefinition | undefined {
  return Object.values(PROVIDERS).find((p) => p.id === id);
}

/** Demo electricity tariff, NGN per kWh. */
export const DEMO_ELECTRICITY_TARIFF_NGN_PER_KWH = 225;
export const ELECTRICITY_STEP_NGN = 500;
export const AIRTIME_STEP_NGN = 100;

export const DATA_BUNDLES: readonly Product[] = [
  { code: "data_750mb_7d", kind: "data", label: "750 MB · 7 days", amountNgn: 500, quantity: 750, unit: "MB", validityHours: 7 * 24 },
  { code: "data_1_5gb_30d", kind: "data", label: "1.5 GB · 30 days", amountNgn: 1_000, quantity: 1_536, unit: "MB", validityHours: 30 * 24 },
  { code: "data_3gb_30d", kind: "data", label: "3 GB · 30 days", amountNgn: 2_000, quantity: 3_072, unit: "MB", validityHours: 30 * 24 },
  { code: "data_10gb_30d", kind: "data", label: "10 GB · 30 days", amountNgn: 4_500, quantity: 10_240, unit: "MB", validityHours: 30 * 24 },
];

export class ProductError extends Error {
  constructor(
    readonly code: "invalid_amount" | "unknown_product" | "unsupported_kind",
    message: string,
  ) {
    super(message);
  }
}

/** Electricity: open amount in ₦500 steps. Units are rounded down to 0.1 kWh. */
export function electricityProduct(amountNgn: number): Product {
  const p = PROVIDERS.electricity;
  if (!Number.isInteger(amountNgn) || amountNgn < p.minAmountNgn || amountNgn > p.maxAmountNgn || amountNgn % ELECTRICITY_STEP_NGN !== 0) {
    throw new ProductError("invalid_amount", `Electricity purchases must be ₦${p.minAmountNgn}–₦${p.maxAmountNgn} in ₦${ELECTRICITY_STEP_NGN} steps.`);
  }
  const kwh = Math.floor((amountNgn / DEMO_ELECTRICITY_TARIFF_NGN_PER_KWH) * 10) / 10;
  return { code: `elec_${amountNgn}`, kind: "electricity", label: `₦${amountNgn.toLocaleString("en-NG")} electricity`, amountNgn, quantity: kwh, unit: "kWh" };
}

export function airtimeProduct(amountNgn: number): Product {
  const p = PROVIDERS.airtime;
  if (!Number.isInteger(amountNgn) || amountNgn < p.minAmountNgn || amountNgn > p.maxAmountNgn || amountNgn % AIRTIME_STEP_NGN !== 0) {
    throw new ProductError("invalid_amount", `Airtime recharges must be ₦${p.minAmountNgn}–₦${p.maxAmountNgn} in ₦${AIRTIME_STEP_NGN} steps.`);
  }
  return { code: `air_${amountNgn}`, kind: "airtime", label: `₦${amountNgn.toLocaleString("en-NG")} airtime`, amountNgn, quantity: amountNgn, unit: "NGN" };
}

export function dataProduct(code: string): Product {
  const product = DATA_BUNDLES.find((b) => b.code === code);
  if (!product) throw new ProductError("unknown_product", `Unknown data bundle "${code}".`);
  return product;
}

/** Resolve a product from a provider order. Single source of truth for price + quantity. */
export function resolveProduct(kind: UtilityKind, input: { amountNgn?: number; productCode?: string }): Product {
  switch (kind) {
    case "electricity":
      return electricityProduct(input.amountNgn ?? NaN);
    case "airtime":
      return airtimeProduct(input.amountNgn ?? NaN);
    case "data":
      return dataProduct(input.productCode ?? "");
    default:
      throw new ProductError("unsupported_kind", `Unsupported utility kind.`);
  }
}
