/** Demo airtime (VTU) providers. Recharges are SIMULATED. */
import type { MobileNetwork } from "../db/schema";
import { ProductError, naira, round, validateMobileOrder, type Product, type ProviderDefinition, type ProviderModule } from "./types";

export interface AirtimeConfig {
  id: string;
  name: string;
  payToEnv: string;
  networks: MobileNetwork[];
  minAmountNgn: number;
  maxAmountNgn: number;
  stepNgn: number;
  /** Extra airtime credited on recharges at or above `bonusFromNgn` (e.g. 0.03 = 3%). */
  bonusRate: number;
  bonusFromNgn: number;
  offerSummary: string;
}

export function createAirtimeProvider(cfg: AirtimeConfig): ProviderModule {
  const definition: ProviderDefinition = {
    id: cfg.id,
    category: "utility",
    kind: "airtime",
    name: cfg.name,
    countryCode: "NG",
    networks: cfg.networks,
    minAmountNgn: cfg.minAmountNgn,
    maxAmountNgn: cfg.maxAmountNgn,
    unit: "NGN",
    payToEnv: cfg.payToEnv,
    offerSummary: cfg.offerSummary,
  };
  const product = (amountNgn: number): Product => {
    if (!Number.isInteger(amountNgn) || amountNgn < cfg.minAmountNgn || amountNgn > cfg.maxAmountNgn || amountNgn % cfg.stepNgn !== 0) {
      throw new ProductError("invalid_amount", `${cfg.name}: recharges must be ${naira(cfg.minAmountNgn)}–${naira(cfg.maxAmountNgn)} in ${naira(cfg.stepNgn)} steps.`);
    }
    const bonus = amountNgn >= cfg.bonusFromNgn ? Math.floor(amountNgn * cfg.bonusRate) : 0;
    const label = bonus ? `${naira(amountNgn)} airtime + ${naira(bonus)} bonus` : `${naira(amountNgn)} airtime`;
    return { code: `air_${amountNgn}`, providerId: cfg.id, kind: "airtime", label, amountNgn, quantity: amountNgn + bonus, unit: "NGN" };
  };
  return {
    definition,
    validateOrder: (order, account) => validateMobileOrder(definition, order, account),
    resolveProduct: (order) => product(order.amountNgn ?? NaN),
    listProducts: () => [200, 500, 1_000, 2_000].filter((a) => a >= cfg.minAmountNgn).map(product),
    fulfil({ product: p, balance, txHash }) {
      return {
        balanceAfter: round(balance.balance + p.quantity, 2),
        demoToken: null,
        details: {
          rechargeType: "VTU (simulated)",
          bonusNgn: p.quantity - p.amountNgn,
          // Short, human-readable reference like the SMS a network would send.
          reference: `BDL${txHash.slice(0, 10).toUpperCase()}`,
        },
      };
    },
  };
}

export const airtimeProvider = createAirtimeProvider({
  id: "prv_demo_airtime",
  name: "Demo Airtime Gateway",
  payToEnv: "PROVIDER_AIRTIME_PAYTO",
  networks: ["mtn", "airtel", "glo", "t2"],
  minAmountNgn: 100,
  maxAmountNgn: 10_000,
  stepNgn: 100,
  bonusRate: 0,
  bonusFromNgn: Number.POSITIVE_INFINITY,
  offerSummary: "Face-value airtime on every network, from ₦100.",
});

export const airtimeProviderB = createAirtimeProvider({
  id: "prv_demo_topuphub",
  name: "Demo TopUp Hub",
  payToEnv: "PROVIDER_TOPUPHUB_PAYTO",
  networks: ["mtn", "airtel"],
  minAmountNgn: 200,
  maxAmountNgn: 10_000,
  stepNgn: 100,
  bonusRate: 0.03,
  bonusFromNgn: 1_000,
  offerSummary: "3% bonus airtime on ₦1,000 and above; MTN and Airtel only.",
});

export const AIRTIME_STEP_NGN = 100;
export const airtimeProduct = (amountNgn: number) => airtimeProvider.resolveProduct({ amountNgn });
