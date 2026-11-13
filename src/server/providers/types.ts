/**
 * Provider module contract.
 *
 * Every demo provider (and any future real one) plugs into the same x402 seller and
 * settlement ledger by implementing this interface. The shared purchase handler owns
 * payment; the module owns everything utility-specific: catalogue, order validation
 * and how a settled purchase is released to the household's device.
 */
import type { Database } from "../db/client";
import type { MobileNetwork, UtilityKind } from "../db/schema";
import type * as s from "../db/schema";

export type Unit = "kWh" | "NGN" | "MB" | "report";

export interface Product {
  /** Unique within its provider. */
  code: string;
  /** The provider that sells this product (several providers can serve one utility). */
  providerId: string;
  kind: UtilityKind;
  label: string;
  amountNgn: number;
  quantity: number;
  unit: Unit;
  /** Data bundles only. */
  validityHours?: number;
}

/** What a provider sells: utility credit, or information that helps the agent decide. */
export type ProviderCategory = "utility" | "intelligence";

export interface ProviderDefinition {
  id: string;
  category: ProviderCategory;
  kind: UtilityKind;
  name: string;
  countryCode: string;
  networks: MobileNetwork[];
  minAmountNgn: number;
  maxAmountNgn: number;
  unit: Unit;
  /** Environment variable holding this provider's receiving wallet (G…). */
  payToEnv: string;
  /** One-line description of what distinguishes this provider's offer (shown to agent and UI). */
  offerSummary: string;
}

export class ProductError extends Error {
  constructor(
    readonly code: "invalid_amount" | "unknown_product" | "unsupported_kind",
    message: string,
  ) {
    super(message);
  }
}

export interface OrderInput {
  accountIdentifier: string;
  network?: MobileNetwork;
  amountNgn?: number;
  productCode?: string;
}

export interface OrderRejection {
  status: 404 | 422;
  code: string;
  message: string;
}

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type AccountRow = typeof s.utilityAccounts.$inferSelect;
export type BalanceRow = typeof s.utilityBalances.$inferSelect;

export interface FulfilmentContext {
  product: Product;
  balance: BalanceRow;
  txHash: string;
  simNow: Date;
}

export interface FulfilmentOutcome {
  balanceAfter: number;
  /** Fields to update on the virtual device besides the balance. */
  deviceUpdate?: Partial<Pick<BalanceRow, "activeBundle" | "expiresAt">>;
  demoToken: string | null;
  details: Record<string, unknown>;
}

export interface ProviderModule {
  definition: ProviderDefinition;
  /** Provider-specific checks on the recipient/meter, beyond schema validation. */
  validateOrder(order: OrderInput, account: AccountRow): OrderRejection | null;
  /** Single source of truth for what an order buys and costs. Throws ProductError. */
  resolveProduct(order: Pick<OrderInput, "amountNgn" | "productCode">): Product;
  /** Products the agent can choose from (for open-amount providers: representative steps). */
  listProducts(): Product[];
  /** Compute the device update for a settled purchase. Pure with respect to the database. */
  fulfil(ctx: FulfilmentContext): FulfilmentOutcome;
  /**
   * Information providers only: produce the paid result (e.g. a diagnostic report) for a
   * settled purchase. Runs only after settlement; never touches the household's devices.
   */
  deliver?(ctx: DeliveryContext): Promise<Record<string, unknown>>;
  /** Information providers only: the paid service's path segment and title. */
  service?: { slug: string; title: string; releases: string };
}

export interface DeliveryContext {
  tx: Tx;
  accountId: string;
  simNow: Date;
  txHash: string;
  product: Product;
}

export const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;
export const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

/** Nigerian mobile number in E.164 form. Prefix → network is NOT inferred (number portability). */
export const NG_MSISDN = /^\+234[789][01]\d{8}$/;

export function validateMobileOrder(definition: ProviderDefinition, order: OrderInput, account: AccountRow): OrderRejection | null {
  if (!NG_MSISDN.test(order.accountIdentifier)) {
    return { status: 422, code: "invalid_msisdn", message: "Recipient must be a Nigerian mobile number in +234 format." };
  }
  if (!order.network || order.network !== account.network) {
    return { status: 422, code: "network_mismatch", message: "The network does not match the recipient line." };
  }
  if (!definition.networks.includes(order.network)) {
    return { status: 422, code: "unsupported_network", message: `${definition.name} does not serve that network.` };
  }
  return null;
}
