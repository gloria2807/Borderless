/**
 * The provider registry. Several providers can serve one utility; each is a configured
 * instance with its own catalogue, pricing, availability and receiving wallet.
 * Adding a provider = add an instance here and a payTo wallet (wallets:setup does it).
 */
import { payToFromEnv } from "../config/env";
import type { UtilityKind } from "../db/schema";
import { airtimeProvider, airtimeProviderB } from "./airtime";
import { dataProvider, dataProviderB } from "./data";
import { electricityProvider, electricityProviderB } from "./electricity";
import type { OrderInput, Product, ProviderDefinition, ProviderModule } from "./types";

export const ALL_PROVIDERS: readonly ProviderModule[] = [electricityProvider, electricityProviderB, airtimeProvider, airtimeProviderB, dataProvider, dataProviderB];

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

export function providersFor(kind: UtilityKind): ProviderModule[] {
  return ALL_PROVIDERS.filter((m) => m.definition.kind === kind);
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
