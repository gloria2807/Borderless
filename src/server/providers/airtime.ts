/** Demo airtime (VTU) provider. Recharges are SIMULATED. */
import {
  ProductError,
  naira,
  round,
  validateMobileOrder,
  type Product,
  type ProviderDefinition,
  type ProviderModule,
} from "./types";

export const AIRTIME_STEP_NGN = 100;

const definition: ProviderDefinition = {
  id: "prv_demo_airtime",
  kind: "airtime",
  name: "Demo Airtime Gateway",
  countryCode: "NG",
  networks: ["mtn", "airtel", "glo", "t2"],
  minAmountNgn: 100,
  maxAmountNgn: 10_000,
  unit: "NGN",
};

export function airtimeProduct(amountNgn: number): Product {
  const d = definition;
  if (
    !Number.isInteger(amountNgn) ||
    amountNgn < d.minAmountNgn ||
    amountNgn > d.maxAmountNgn ||
    amountNgn % AIRTIME_STEP_NGN !== 0
  ) {
    throw new ProductError(
      "invalid_amount",
      `Airtime recharges must be ${naira(d.minAmountNgn)}–${naira(d.maxAmountNgn)} in ${naira(AIRTIME_STEP_NGN)} steps.`,
    );
  }
  return { code: `air_${amountNgn}`, kind: "airtime", label: `${naira(amountNgn)} airtime`, amountNgn, quantity: amountNgn, unit: "NGN" };
}

export const airtimeProvider: ProviderModule = {
  definition,
  validateOrder: (order, account) => validateMobileOrder(definition, order, account),
  resolveProduct: (order) => airtimeProduct(order.amountNgn ?? NaN),
  listProducts: () => [200, 500, 1_000, 2_000].map(airtimeProduct),
  fulfil({ product, balance, txHash }) {
    return {
      balanceAfter: round(balance.balance + product.quantity, 2),
      demoToken: null,
      details: {
        rechargeType: "VTU (simulated)",
        // Short, human-readable reference like the SMS a network would send.
        reference: `BDL${txHash.slice(0, 10).toUpperCase()}`,
      },
    };
  },
};
