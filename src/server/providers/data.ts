/**
 * Demo mobile data providers. Bundles are a DEMO CATALOGUE, not real network tariffs.
 *
 * Bundle rules (simulated, modelled on common prepaid behaviour):
 *  - Buying while a bundle is active stacks the data and keeps the later expiry.
 *  - Buying after the active bundle has expired forfeits the expired remainder.
 */
import type { MobileNetwork } from "../db/schema";
import { ProductError, round, validateMobileOrder, type Product, type ProviderDefinition, type ProviderModule } from "./types";

type Bundle = Omit<Product, "providerId" | "kind" | "unit">;

export interface DataConfig {
  id: string;
  name: string;
  payToEnv: string;
  networks: MobileNetwork[];
  bundles: Bundle[];
  offerSummary: string;
}

export function createDataProvider(cfg: DataConfig): ProviderModule & { bundles: readonly Product[] } {
  const bundles: Product[] = cfg.bundles.map((b) => ({ ...b, providerId: cfg.id, kind: "data", unit: "MB" }));
  const definition: ProviderDefinition = {
    id: cfg.id,
    kind: "data",
    name: cfg.name,
    countryCode: "NG",
    networks: cfg.networks,
    minAmountNgn: Math.min(...bundles.map((b) => b.amountNgn)),
    maxAmountNgn: Math.max(...bundles.map((b) => b.amountNgn)),
    unit: "MB",
    payToEnv: cfg.payToEnv,
    offerSummary: cfg.offerSummary,
  };
  const find = (code: string) => {
    const p = bundles.find((b) => b.code === code);
    if (!p) throw new ProductError("unknown_product", `${cfg.name} has no data bundle "${code}".`);
    return p;
  };
  return {
    definition,
    bundles,
    validateOrder(order, account) {
      if (order.amountNgn !== undefined) return { status: 422, code: "unexpected_amount", message: "Data is bought by bundle code, not by amount." };
      return validateMobileOrder(definition, order, account);
    },
    resolveProduct: (order) => find(order.productCode ?? ""),
    listProducts: () => [...bundles],
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
}

export const dataProvider = createDataProvider({
  id: "prv_demo_data",
  name: "Demo Data Gateway",
  payToEnv: "PROVIDER_DATA_PAYTO",
  networks: ["mtn", "airtel", "glo", "t2"],
  offerSummary: "Weekly and monthly bundles on every network.",
  bundles: [
    { code: "data_750mb_7d", label: "750 MB · 7 days", amountNgn: 500, quantity: 750, validityHours: 7 * 24 },
    { code: "data_1_5gb_30d", label: "1.5 GB · 30 days", amountNgn: 1_000, quantity: 1_536, validityHours: 30 * 24 },
    { code: "data_3gb_30d", label: "3 GB · 30 days", amountNgn: 2_000, quantity: 3_072, validityHours: 30 * 24 },
    { code: "data_10gb_30d", label: "10 GB · 30 days", amountNgn: 4_500, quantity: 10_240, validityHours: 30 * 24 },
  ],
});

export const dataProviderB = createDataProvider({
  id: "prv_demo_datalink",
  name: "Demo DataLink",
  payToEnv: "PROVIDER_DATALINK_PAYTO",
  networks: ["mtn", "airtel", "glo"],
  offerSummary: "Short-validity bundles and cheaper mid-size monthly plans; no 9mobile.",
  bundles: [
    { code: "dl_1gb_3d", label: "1 GB · 3 days", amountNgn: 400, quantity: 1_024, validityHours: 3 * 24 },
    { code: "dl_2gb_14d", label: "2 GB · 14 days", amountNgn: 900, quantity: 2_048, validityHours: 14 * 24 },
    { code: "dl_4gb_30d", label: "4 GB · 30 days", amountNgn: 1_800, quantity: 4_096, validityHours: 30 * 24 },
    { code: "dl_8gb_30d", label: "8 GB · 30 days", amountNgn: 3_200, quantity: 8_192, validityHours: 30 * 24 },
  ],
});

/** Back-compat helpers bound to the original provider (tests, scripts). */
export const DATA_BUNDLES = dataProvider.bundles;
export const dataProduct = (code: string) => dataProvider.resolveProduct({ productCode: code });
