/** The provider registry. Adding a provider = add a module here (and a payTo wallet). */
import type { UtilityKind } from "../db/schema";
import { airtimeProvider } from "./airtime";
import { dataProvider } from "./data";
import { electricityProvider } from "./electricity";
import type { OrderInput, Product, ProviderDefinition, ProviderModule } from "./types";

export const PROVIDER_MODULES: Record<UtilityKind, ProviderModule> = {
  electricity: electricityProvider,
  airtime: airtimeProvider,
  data: dataProvider,
};

export const PROVIDERS: Record<UtilityKind, ProviderDefinition> = {
  electricity: electricityProvider.definition,
  airtime: airtimeProvider.definition,
  data: dataProvider.definition,
};

export function providerById(id: string): ProviderModule | undefined {
  return Object.values(PROVIDER_MODULES).find((m) => m.definition.id === id);
}

export function resolveProduct(kind: UtilityKind, order: Pick<OrderInput, "amountNgn" | "productCode">): Product {
  return PROVIDER_MODULES[kind].resolveProduct(order);
}
