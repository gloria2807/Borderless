/**
 * Demo prepaid electricity providers (simulated DisCo vending).
 * Tariffs and tokens are DEMO VALUES. A demo token is never valid on a physical meter.
 */
import { createHash } from "node:crypto";
import { ProductError, naira, round, type Product, type ProviderDefinition, type ProviderModule } from "./types";

const METER_NUMBER = /^\d{11}$/;

/** 20-digit DEMO token derived from the settlement tx (deterministic, auditable). */
export function demoElectricityToken(txHash: string): string {
  const digest = createHash("sha256").update(`borderless-demo-token:${txHash}`).digest();
  let digits = "";
  for (const byte of digest) {
    digits += (byte % 10).toString();
    if (digits.length === 20) break;
  }
  return digits.match(/.{4}/g)!.join("-");
}

/** The demo household's distribution company (simulated). Its tariff applies through every authorised vendor. */
export const DEMO_DISCO = "Demo Eko DisCo";
/** Simulated Band B tariff. Vendors don't set tariffs; the DisCo does. */
export const DEMO_DISCO_TARIFF_NGN_PER_KWH = 225;

export interface ElectricityConfig {
  id: string;
  name: string;
  payToEnv: string;
  tariffNgnPerKwh: number;
  /** Flat convenience fee the vendor keeps from each vend; the rest buys units at the tariff. */
  serviceFeeNgn: number;
  distributionCompanies: string[];
  minAmountNgn: number;
  maxAmountNgn: number;
  stepNgn: number;
  offerSummary: string;
}

export function createElectricityProvider(cfg: ElectricityConfig): ProviderModule & { tariffNgnPerKwh: number } {
  const definition: ProviderDefinition = {
    id: cfg.id,
    category: "utility",
    kind: "electricity",
    name: cfg.name,
    countryCode: "NG",
    networks: [],
    minAmountNgn: cfg.minAmountNgn,
    maxAmountNgn: cfg.maxAmountNgn,
    unit: "kWh",
    payToEnv: cfg.payToEnv,
    offerSummary: cfg.offerSummary,
    distributionCompanies: cfg.distributionCompanies,
  };
  const product = (amountNgn: number): Product => {
    if (!Number.isInteger(amountNgn) || amountNgn < cfg.minAmountNgn || amountNgn > cfg.maxAmountNgn || amountNgn % cfg.stepNgn !== 0) {
      throw new ProductError(
        "invalid_amount",
        `${cfg.name}: purchases must be ${naira(cfg.minAmountNgn)}–${naira(cfg.maxAmountNgn)} in ${naira(cfg.stepNgn)} steps.`,
      );
    }
    const kwh = Math.floor(((amountNgn - cfg.serviceFeeNgn) / cfg.tariffNgnPerKwh) * 10) / 10;
    return { code: `elec_${amountNgn}`, providerId: cfg.id, kind: "electricity", label: `${naira(amountNgn)} electricity`, amountNgn, quantity: kwh, unit: "kWh" };
  };
  const listed = [1_000, 1_500, 2_000, 3_000, 4_000, 5_000].filter((a) => a >= cfg.minAmountNgn && a % cfg.stepNgn === 0);
  return {
    definition,
    tariffNgnPerKwh: cfg.tariffNgnPerKwh,
    validateOrder(order) {
      if (!METER_NUMBER.test(order.accountIdentifier)) return { status: 422, code: "invalid_meter_number", message: "Meter numbers are 11 digits." };
      if (order.network) return { status: 422, code: "unexpected_network", message: "Electricity orders do not take a mobile network." };
      return null;
    },
    resolveProduct: (order) => product(order.amountNgn ?? NaN),
    listProducts: () => listed.map(product),
    fulfil({ product: p, balance, txHash }) {
      return {
        balanceAfter: round(balance.balance + p.quantity),
        demoToken: demoElectricityToken(txHash),
        details: {
          unitsVended: p.quantity,
          tariffNgnPerKwh: cfg.tariffNgnPerKwh,
          serviceFeeNgn: cfg.serviceFeeNgn,
          distributionCompany: cfg.distributionCompanies[0],
          tariffNote: "Demo tariff, not a real DisCo rate",
          tokenNote: "Demo token, not valid on any physical meter",
        },
      };
    },
  };
}

export const electricityProvider = createElectricityProvider({
  id: "prv_demo_electricity",
  name: "Demo Prepaid Electricity",
  payToEnv: "PROVIDER_ELECTRICITY_PAYTO",
  tariffNgnPerKwh: DEMO_DISCO_TARIFF_NGN_PER_KWH,
  serviceFeeNgn: 100,
  distributionCompanies: [DEMO_DISCO],
  minAmountNgn: 1_000,
  maxAmountNgn: 20_000,
  stepNgn: 500,
  offerSummary: "Authorised vendor for Demo Eko DisCo. Flexible amounts from ₦1,000 in ₦500 steps; ₦100 service fee per vend.",
});

export const electricityProviderB = createElectricityProvider({
  id: "prv_demo_powergrid",
  name: "Demo PowerGrid Vend",
  payToEnv: "PROVIDER_POWERGRID_PAYTO",
  tariffNgnPerKwh: DEMO_DISCO_TARIFF_NGN_PER_KWH,
  serviceFeeNgn: 0,
  distributionCompanies: [DEMO_DISCO],
  minAmountNgn: 2_000,
  maxAmountNgn: 20_000,
  stepNgn: 1_000,
  offerSummary: "Authorised vendor for Demo Eko DisCo. No service fee, but only from ₦2,000 in ₦1,000 steps.",
});

/** Back-compat helpers bound to the original provider (tests, scripts). */
export const DEMO_ELECTRICITY_TARIFF_NGN_PER_KWH = electricityProvider.tariffNgnPerKwh;
export const electricityProduct = (amountNgn: number) => electricityProvider.resolveProduct({ amountNgn });
