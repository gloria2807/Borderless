/**
 * The provider registry. Several providers can serve one utility; each is a configured
 * instance with its own catalogue, pricing, availability and receiving wallet.
 * Adding a provider = add an instance here and a payTo wallet (wallets:setup does it).
 */
import { payToFromEnv } from "../config/env";
import type { MobileNetwork, UtilityKind } from "../db/schema";
import { airtimeProvider, airtimeProviderB } from "./airtime";
import { dataProvider, dataProviderB } from "./data";
import { gridSenseDiagnostics, meterLabDiagnostics } from "./diagnostics";
import { electricityProvider, electricityProviderB } from "./electricity";
import type { OrderInput, Product, ProviderDefinition, ProviderModule } from "./types";

export const ALL_PROVIDERS: readonly ProviderModule[] = [
  electricityProvider,
  electricityProviderB,
  airtimeProvider,
  airtimeProviderB,
  dataProvider,
  dataProviderB,
  // Information providers (paid meter diagnostics).
  gridSenseDiagnostics,
  meterLabDiagnostics,
];

/** The original (default) provider per utility; household accounts point here by default. */
export const DEFAULT_PROVIDER: Record<UtilityKind, ProviderModule> = {
  electricity: electricityProvider,
  airtime: airtimeProvider,
  data: dataProvider,
};

/** @deprecated single-provider view kept for callers that only need the default. */
export const PROVIDER_MODULES = DEFAULT_PROVIDER;
export const PROVIDERS: Record<UtilityKind, ProviderDefinition> = {
  electricity: electricityProvider.definition,
  airtime: airtimeProvider.definition,
  data: dataProvider.definition,
};

export function providerById(id: string): ProviderModule | undefined {
  return ALL_PROVIDERS.find((m) => m.definition.id === id);
}

export function requireProvider(id: string): ProviderModule {
  const p = providerById(id);
  if (!p) throw new Error(`Unknown provider ${id}`);
  return p;
}

/** Providers that sell utility CREDIT for a utility (the catalogue the engine buys from). */
export function providersFor(kind: UtilityKind): ProviderModule[] {
  return ALL_PROVIDERS.filter((m) => m.definition.category === "utility" && m.definition.kind === kind);
}

/** Providers that sell INFORMATION about a utility (e.g. meter diagnostics). */
export function intelligenceProvidersFor(kind: UtilityKind): ProviderModule[] {
  return ALL_PROVIDERS.filter((m) => m.definition.category === "intelligence" && m.definition.kind === kind);
}

/** What makes a provider able to serve a specific household account. */
export interface AccountEligibilityInput {
  kind: UtilityKind;
  network: MobileNetwork | null;
  distributionCompany: string | null;
}

export interface Eligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Real-world constraints, not price: a prepaid meter can only be recharged through vendors
 * authorised for the DisCo that serves it; airtime and data can only be bought on the
 * line's own mobile network. A cheaper offer elsewhere is not an option for this household.
 */
export function eligibilityFor(m: ProviderModule, account: AccountEligibilityInput): Eligibility {
  const d = m.definition;
  if (d.kind !== account.kind) return { eligible: false, reason: `Sells ${d.kind}, not ${account.kind}.` };
  if (account.kind === "electricity") {
    const discos = d.distributionCompanies ?? [];
    if (!account.distributionCompany) return { eligible: false, reason: "The meter's distribution company is unknown, so no vendor can be confirmed." };
    return discos.includes(account.distributionCompany)
      ? { eligible: true, reason: `Authorised vendor for ${account.distributionCompany}, which serves this meter.` }
      : { eligible: false, reason: `Sells only for ${discos.join(", ") || "other distribution companies"}; this meter is served by ${account.distributionCompany}.` };
  }
  if (!account.network) return { eligible: false, reason: "The line's mobile network is unknown." };
  return d.networks.includes(account.network)
    ? { eligible: true, reason: `Serves ${account.network.toUpperCase()}, the line's network.` }
    : { eligible: false, reason: `Doesn't serve ${account.network.toUpperCase()}; the household can't switch networks to use it.` };
}

/** Utility providers that can actually serve this account. */
export function eligibleProvidersFor(account: AccountEligibilityInput): ProviderModule[] {
  return providersFor(account.kind).filter((m) => eligibilityFor(m, account).eligible);
}

/** Every product from every provider of a utility (each carries its providerId). */
export function productsFor(kind: UtilityKind): Product[] {
  return providersFor(kind).flatMap((m) => m.listProducts());
}

/** Resolve a product from a specific provider's catalogue. */
export function resolveProviderProduct(providerId: string, order: Pick<OrderInput, "amountNgn" | "productCode">): Product {
  return requireProvider(providerId).resolveProduct(order);
}

/** @deprecated resolves against the utility's default provider. Prefer resolveProviderProduct. */
export function resolveProduct(kind: UtilityKind, order: Pick<OrderInput, "amountNgn" | "productCode">): Product {
  return DEFAULT_PROVIDER[kind].resolveProduct(order);
}

/** The provider's registered receiving wallet (trust anchor for payees). */
export function providerPayTo(providerId: string): string {
  return payToFromEnv(requireProvider(providerId).definition.payToEnv);
}
