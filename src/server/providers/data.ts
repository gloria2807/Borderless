/**
 * Demo mobile data provider. Bundles are a DEMO CATALOGUE, not real network tariffs.
 *
 * Bundle rules (simulated, modelled on common prepaid behaviour):
 *  - Buying while a bundle is active stacks the data and keeps the later expiry.
 *  - Buying after the active bundle has expired forfeits the expired remainder.
 */
import {
  ProductError,
  round,
  validateMobileOrder,
  type Product,
  type ProviderDefinition,
  type ProviderModule,
} from "./types";

const definition: ProviderDefinition = {
  id: "prv_demo_data",
  kind: "data",
  name: "Demo Data Gateway",
  countryCode: "NG",
  networks: ["mtn", "airtel", "glo", "t2"],
  minAmountNgn: 500,
  maxAmountNgn: 10_000,
  unit: "MB",
};

export const DATA_BUNDLES: readonly Product[] = [
  { code: "data_750mb_7d", kind: "data", label: "750 MB · 7 days", amountNgn: 500, quantity: 750, unit: "MB", validityHours: 7 * 24 },
  { code: "data_1_5gb_30d", kind: "data", label: "1.5 GB · 30 days", amountNgn: 1_000, quantity: 1_536, unit: "MB", validityHours: 30 * 24 },
  { code: "data_3gb_30d", kind: "data", label: "3 GB · 30 days", amountNgn: 2_000, quantity: 3_072, unit: "MB", validityHours: 30 * 24 },
  { code: "data_10gb_30d", kind: "data", label: "10 GB · 30 days", amountNgn: 4_500, quantity: 10_240, unit: "MB", validityHours: 30 * 24 },
];

export function dataProduct(code: string): Product {
  const product = DATA_BUNDLES.find((b) => b.code === code);
  if (!product) throw new ProductError("unknown_product", `Unknown data bundle "${code}".`);
  return product;
}

export const dataProvider: ProviderModule = {
  definition,
  validateOrder(order, account) {
    if (order.amountNgn !== undefined) {
      return { status: 422, code: "unexpected_amount", message: "Data is bought by bundle code, not by amount." };
    }
    return validateMobileOrder(definition, order, account);
  },
  resolveProduct: (order) => dataProduct(order.productCode ?? ""),
  listProducts: () => [...DATA_BUNDLES],
  fulfil({ product, balance, simNow }) {
    const validityMs = (product.validityHours ?? 24 * 30) * 3_600_000;
    const newExpiry = new Date(simNow.getTime() + validityMs);
    const active = balance.expiresAt !== null && balance.expiresAt.getTime() > simNow.getTime();
    const carried = active ? balance.balance : 0;
    const forfeitedMb = active ? 0 : round(balance.balance);
    const expiresAt = active && balance.expiresAt! > newExpiry ? balance.expiresAt! : newExpiry;
    return {
      balanceAfter: round(carried + product.quantity),
      deviceUpdate: { activeBundle: product.label, expiresAt },
      demoToken: null,
      details: {
        bundle: product.label,
        validityHours: product.validityHours,
        expiresAt: expiresAt.toISOString(),
        stackedOnActiveBundle: active,
        ...(forfeitedMb > 0 ? { forfeitedExpiredMb: forfeitedMb } : {}),
      },
    };
  },
};
