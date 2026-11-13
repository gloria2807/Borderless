/**
 * The provider network's FREE, public surface (procurement amendment A1).
 *
 *  - GET /api/providers                 the curated registry listing: who exists and where
 *                                        their service document lives.
 *  - GET /api/providers/:id/service     the provider's PUBLISHED service document: what it
 *                                        sells, prices, endpoints (free vs paid), fulfilment
 *                                        terms and how it is paid.
 *
 * Discovery is free and returns metadata only — never a utility credit or a paid result.
 * Paid resources are released only by the provider's x402-protected endpoints.
 *
 * Everything a provider publishes is UNTRUSTED. The buyer pays only the payee in the
 * server's registry (`providerPayTo`), and verifyServiceDocument() checks a document
 * against that registry before the agent may treat the provider as payable.
 */
import { eq } from "drizzle-orm";
import { env } from "../config/env";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { DEMO_INJECTION_PROVIDER, DEMO_INJECTION_TEXT, isFaultEnabled } from "../demo/faults";
import { TESTNET_USDC } from "../payments/pricing";
import { ALL_PROVIDERS, providerById, providerPayTo } from "./registry";
import type { ProviderCategory, ProviderModule } from "./types";
import { providerQuotePath, providerRoutePath } from "./x402-seller";

export const SERVICE_DOC_VERSION = "borderless.service/1";

export interface RegistryEntry {
  providerId: string;
  name: string;
  category: ProviderCategory;
  utility: UtilityKind;
  /** Where the provider publishes its service document (relative to the app). */
  serviceDocument: string;
  simulated: true;
}

export interface ServiceEndpoint {
  name: string;
  method: "GET" | "POST";
  path: string;
  /** true = protected by x402: the resource is released only after payment settles. */
  paid: boolean;
  protocol: "x402" | null;
  description: string;
}

export interface ServiceDocument {
  version: typeof SERVICE_DOC_VERSION;
  providerId: string;
  name: string;
  category: ProviderCategory;
  /** Provider-written description. Untrusted text. */
  description: string;
  serves: { utility: UtilityKind; country: string; networks: string[] };
  products: { code: string; label: string; priceNgn: number; quantity: number; unit: string; validityHours: number | null }[];
  denominations: { minNgn: number; maxNgn: number };
  availability: { available: boolean; checkedAt: string };
  fulfilment: { releases: string; when: string };
  endpoints: ServiceEndpoint[];
  payment: { protocol: "x402"; scheme: "exact"; network: "stellar:testnet"; asset: { code: string; contract: string }; payTo: string | null; pricing: string };
  simulated: true;
}

const RELEASES: Record<UtilityKind, string> = {
  electricity: "kWh credited to the household's meter, with a 20-digit demo token",
  airtime: "Airtime credited to the household's line",
  data: "A data bundle activated on the household's line",
};

export function registryListing(): RegistryEntry[] {
  return ALL_PROVIDERS.map((m) => ({
    providerId: m.definition.id,
    name: m.definition.name,
    category: m.definition.category,
    utility: m.definition.kind,
    serviceDocument: `/api/providers/${m.definition.id}/service`,
    simulated: true,
  }));
}

/** What the provider says about itself. Hostile text in the injection demo, as a real provider's could be. */
async function providerDescription(m: ProviderModule): Promise<string> {
  if (m.definition.id === DEMO_INJECTION_PROVIDER && (await isFaultEnabled("provider_prompt_injection"))) return DEMO_INJECTION_TEXT;
  return m.definition.offerSummary;
}

export async function serviceDocument(db: Database, m: ProviderModule): Promise<ServiceDocument> {
  const d = m.definition;
  const [row] = await db.select().from(s.utilityProviders).where(eq(s.utilityProviders.id, d.id));
  let payTo: string | null;
  try {
    payTo = providerPayTo(d.id);
  } catch {
    payTo = null;
  }
  return {
    version: SERVICE_DOC_VERSION,
    providerId: d.id,
    name: d.name,
    category: d.category,
    description: await providerDescription(m),
    serves: { utility: d.kind, country: d.countryCode, networks: [...d.networks] },
    products: m.listProducts().map((p) => ({ code: p.code, label: p.label, priceNgn: p.amountNgn, quantity: p.quantity, unit: p.unit, validityHours: p.validityHours ?? null })),
    denominations: { minNgn: d.minAmountNgn, maxNgn: d.maxAmountNgn },
    availability: { available: row?.available ?? false, checkedAt: new Date().toISOString() },
    fulfilment: m.service
      ? { releases: m.service.releases, when: "Only after the x402 payment has settled on Stellar testnet. Simulated: generated from simulated smart-meter telemetry." }
      : { releases: RELEASES[d.kind], when: "Only after the x402 payment has settled on Stellar testnet. Simulated: no real utility is delivered." },
    endpoints: m.service
      ? [
          { name: "service", method: "GET", path: `/api/providers/${d.id}/service`, paid: false, protocol: null, description: "This document." },
          {
            name: m.service.slug,
            method: "POST",
            path: `/api/services/${d.id}/${m.service.slug}`,
            paid: true,
            protocol: "x402",
            description: `${m.service.title} for one meter. Answers HTTP 402 with the price until paid; releases the report after settlement.`,
          },
        ]
      : [
          { name: "service", method: "GET", path: `/api/providers/${d.id}/service`, paid: false, protocol: null, description: "This document." },
          { name: "quote", method: "POST", path: providerQuotePath(d.id), paid: false, protocol: null, description: "A binding 5-minute quote for one product and recipient. Free; releases nothing." },
          { name: "purchase", method: "POST", path: providerRoutePath(d.id), paid: true, protocol: "x402", description: "Redeems a quote. Answers HTTP 402 until paid; releases the utility after settlement." },
        ],
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: "stellar:testnet",
      asset: { code: TESTNET_USDC.code, contract: TESTNET_USDC.contract },
      payTo,
      pricing: `Naira prices settle in test USDC at a fixed demo rate of ₦${env().DEMO_NGN_PER_TESTNET_USDC.toLocaleString("en-NG")} per USDC (not an exchange rate).`,
    },
    simulated: true,
  };
}

export interface Verification {
  verified: boolean;
  /** Why not, in plain language (empty when verified). */
  problems: string[];
}

/**
 * Check a published document against the registry (the trust anchor). A provider is
 * payable only if it is registered, identifies itself consistently, and publishes the
 * registered payee on the expected network and asset. Text fields are never trusted.
 */
export function verifyServiceDocument(expectedProviderId: string, doc: unknown): Verification {
  const problems: string[] = [];
  const m = providerById(expectedProviderId);
  if (!m) return { verified: false, problems: ["Not in Borderless's provider registry."] };
  const d = (doc && typeof doc === "object" ? doc : {}) as Partial<ServiceDocument>;
  if (d.version !== SERVICE_DOC_VERSION) problems.push("Unrecognised service document format.");
  if (d.providerId !== expectedProviderId) problems.push("The document names a different provider.");
  let registered: string | null = null;
  try {
    registered = providerPayTo(expectedProviderId);
  } catch {
    problems.push("No registered payee wallet is configured for this provider.");
  }
  if (registered && d.payment?.payTo !== registered) problems.push("The published payee wallet is not the provider's registered wallet.");
  if (d.payment?.network !== "stellar:testnet") problems.push("The published payment network is not Stellar testnet.");
  if (d.payment?.asset?.contract !== TESTNET_USDC.contract) problems.push("The published payment asset is not test USDC.");
  const paid = (d.endpoints ?? []).filter((e) => e?.paid);
  if (paid.some((e) => e.protocol !== "x402")) problems.push("A paid endpoint does not use x402.");
  const allowed = [`/api/providers/${expectedProviderId}/`, `/api/services/${expectedProviderId}/`];
  if (paid.some((e) => typeof e.path !== "string" || !allowed.some((prefix) => e.path.startsWith(prefix)))) problems.push("A paid endpoint is outside the provider's registered address.");
  return { verified: problems.length === 0, problems };
}

// ── HTTP handlers (shared by the routes and the in-process test fetch) ─────────

export function handleRegistryRequest(): Response {
  return Response.json({ providers: registryListing(), note: "Demo provider network. Discovery is free; paid resources require x402." });
}

export async function handleServiceDocumentRequest(db: Database, m: ProviderModule): Promise<Response> {
  return Response.json(await serviceDocument(db, m), { headers: { "cache-control": "no-store" } });
}
