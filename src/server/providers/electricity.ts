/**
 * Demo prepaid electricity provider (simulated DisCo vending).
 * Tariff and token are DEMO VALUES. A demo token is never valid on a physical meter.
 */
import { createHash } from "node:crypto";
import { ProductError, naira, round, type Product, type ProviderDefinition, type ProviderModule } from "./types";

export const DEMO_ELECTRICITY_TARIFF_NGN_PER_KWH = 225;
export const ELECTRICITY_STEP_NGN = 500;
const METER_NUMBER = /^\d{11}$/;

const definition: ProviderDefinition = {
  id: "prv_demo_electricity",
  kind: "electricity",
  name: "Demo Prepaid Electricity",
  countryCode: "NG",
  networks: [],
  minAmountNgn: 1_000,
  maxAmountNgn: 20_000,
  unit: "kWh",
};

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

export function electricityProduct(amountNgn: number): Product {
  const d = definition;
  if (
    !Number.isInteger(amountNgn) ||
    amountNgn < d.minAmountNgn ||
    amountNgn > d.maxAmountNgn ||
    amountNgn % ELECTRICITY_STEP_NGN !== 0
  ) {
    throw new ProductError(
      "invalid_amount",
      `Electricity purchases must be ${naira(d.minAmountNgn)}–${naira(d.maxAmountNgn)} in ${naira(ELECTRICITY_STEP_NGN)} steps.`,
    );
  }
  const kwh = Math.floor((amountNgn / DEMO_ELECTRICITY_TARIFF_NGN_PER_KWH) * 10) / 10;
  return { code: `elec_${amountNgn}`, kind: "electricity", label: `${naira(amountNgn)} electricity`, amountNgn, quantity: kwh, unit: "kWh" };
}

export const electricityProvider: ProviderModule = {
  definition,
  validateOrder(order) {
    if (!METER_NUMBER.test(order.accountIdentifier)) {
      return { status: 422, code: "invalid_meter_number", message: "Meter numbers are 11 digits." };
    }
    if (order.network) {
      return { status: 422, code: "unexpected_network", message: "Electricity orders do not take a mobile network." };
    }
    return null;
  },
  resolveProduct: (order) => electricityProduct(order.amountNgn ?? NaN),
  listProducts: () => [1_000, 1_500, 2_000, 3_000, 4_000, 5_000].map(electricityProduct),
  fulfil({ product, balance, txHash }) {
    return {
      balanceAfter: round(balance.balance + product.quantity),
      demoToken: demoElectricityToken(txHash),
      details: {
        unitsVended: product.quantity,
        tariffNgnPerKwh: DEMO_ELECTRICITY_TARIFF_NGN_PER_KWH,
        tariffNote: "Demo tariff, not a real DisCo rate",
        tokenNote: "Demo token, not valid on any physical meter",
      },
    };
  },
};
