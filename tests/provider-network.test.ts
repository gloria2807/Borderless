/**
 * Provider network and discovery (procurement amendment A1). Proves:
 *  - the registry listing and each provider's published service document are free,
 *    machine-readable metadata that release nothing;
 *  - documents mark free vs paid (x402) endpoints and publish payment terms;
 *  - code verifies every document against the registry (the trust anchor), and an
 *    unverified provider cannot be paid;
 *  - the agent discovers providers over real HTTP requests, not by reading the registry.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as registryRoute } from "@/app/api/providers/route";
import { GET as serviceRoute } from "@/app/api/providers/[providerId]/service/route";
import { createRun } from "@/server/agent/runtime/run-log";
import { callTool, type ToolContext } from "@/server/agent/runtime/tools";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_HOUSEHOLD_ID } from "@/server/household/seed";
import { TESTNET_USDC } from "@/server/payments/pricing";
import { SERVICE_DOC_VERSION, verifyServiceDocument, type RegistryEntry, type ServiceDocument } from "@/server/providers/catalog";
import { configureTestEnv, freshDatabase, TEST_KEYS } from "./helpers";
import { providerFetch, type ProviderFetchOptions } from "./provider-fetch";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const doc = async (id: string) => (await (await serviceRoute(new Request(`http://localhost/api/providers/${id}/service`), { params: Promise.resolve({ providerId: id }) })).json()) as ServiceDocument;

describe("registry listing (free)", () => {
  it("lists every registered provider and where it publishes its service document", async () => {
    const body = (await registryRoute().json()) as { providers: RegistryEntry[] };
    expect(body.providers.map((p) => [p.providerId, p.category])).toEqual([
      ["prv_demo_electricity", "utility"],
      ["prv_demo_powergrid", "utility"],
      ["prv_demo_airtime", "utility"],
      ["prv_demo_topuphub", "utility"],
      ["prv_demo_data", "utility"],
      ["prv_demo_datalink", "utility"],
      ["prv_demo_gridsense", "intelligence"],
      ["prv_demo_meterlab", "intelligence"],
    ]);
    for (const p of body.providers) {
      expect(p).toMatchObject({ simulated: true, serviceDocument: `/api/providers/${p.providerId}/service` });
    }
  });
});

describe("published service documents (free metadata)", () => {
  it("describe products, terms, availability and how the provider is paid", async () => {
    const d = await doc("prv_demo_powergrid");
    expect(d).toMatchObject({
      version: SERVICE_DOC_VERSION,
      providerId: "prv_demo_powergrid",
      name: "Demo PowerGrid Vend",
      category: "utility",
      serves: { utility: "electricity", country: "NG" },
      denominations: { minNgn: 2000, maxNgn: 20000 },
      availability: { available: true },
      payment: { protocol: "x402", scheme: "exact", network: "stellar:testnet", asset: { code: "USDC", contract: TESTNET_USDC.contract }, payTo: TEST_KEYS.powergrid },
      simulated: true,
    });
    expect(d.products.map((p) => p.priceNgn)).toEqual([2000, 3000, 4000, 5000]);
    expect(d.fulfilment.when).toMatch(/Only after the x402 payment has settled/);
  });

  it("mark which endpoints are free and which are paid through x402", async () => {
    const d = await doc("prv_demo_datalink");
    expect(d.endpoints.map((e) => [e.name, e.paid, e.protocol])).toEqual([
      ["service", false, null],
      ["quote", false, null],
      ["purchase", true, "x402"],
    ]);
    expect(d.endpoints.find((e) => e.paid)?.path).toBe("/api/providers/prv_demo_datalink/purchase");
  });

  it("reflect a provider outage, and release nothing", async () => {
    await database.update(s.utilityProviders).set({ available: false }).where(eq(s.utilityProviders.id, "prv_demo_powergrid"));
    const d = await doc("prv_demo_powergrid");
    expect(d.availability.available).toBe(false);
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/demoToken|balanceAfter|quoteId|qt_[0-9a-z]|\d{4}-\d{4}-\d{4}/); // metadata only: no tokens, credits or quotes
  });

  it("answer 404 for an unregistered provider", async () => {
    const res = await serviceRoute(new Request("http://localhost/api/providers/prv_attacker/service"), { params: Promise.resolve({ providerId: "prv_attacker" }) });
    expect(res.status).toBe(404);
  });
});

describe("verification against the registry", () => {
  it("accepts an honest document", async () => {
    expect(verifyServiceDocument("prv_demo_airtime", await doc("prv_demo_airtime"))).toEqual({ verified: true, problems: [] });
  });

  it.each([
    ["a different payee", (d: ServiceDocument) => ({ ...d, payment: { ...d.payment, payTo: TEST_KEYS.agent.publicKey() } }), /payee wallet is not the provider's registered wallet/],
    ["another network", (d: ServiceDocument) => ({ ...d, payment: { ...d.payment, network: "stellar:pubnet" } }), /not Stellar testnet/],
    ["another asset", (d: ServiceDocument) => ({ ...d, payment: { ...d.payment, asset: { code: "USDC", contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" } } }), /not test USDC/],
    ["a paid endpoint elsewhere", (d: ServiceDocument) => ({ ...d, endpoints: d.endpoints.map((e) => (e.paid ? { ...e, path: "https://attacker.example/pay" } : e)) }), /outside the provider's registered address/],
    ["a paid endpoint without x402", (d: ServiceDocument) => ({ ...d, endpoints: d.endpoints.map((e) => (e.paid ? { ...e, protocol: null } : e)) }), /does not use x402/],
    ["someone else's identity", (d: ServiceDocument) => ({ ...d, providerId: "prv_demo_data" }), /different provider/],
  ])("rejects a document with %s", async (_label, tamper, problem) => {
    const r = verifyServiceDocument("prv_demo_airtime", tamper(await doc("prv_demo_airtime")));
    expect(r.verified).toBe(false);
    expect(r.problems.join(" ")).toMatch(problem);
  });

  it("rejects providers that are not in the registry at all", () => {
    expect(verifyServiceDocument("prv_attacker", {})).toEqual({ verified: false, problems: ["Not in Borderless's provider registry."] });
  });
});

describe("agent discovery over HTTP", () => {
  async function ctxWith(opts: ProviderFetchOptions = {}) {
    const runId = await createRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "ai", model: "t", task: "t", trigger: "manual", simTime: new Date() });
    const pf = providerFetch(opts);
    const ctx: ToolContext = { db: database, runId, householdId: DEMO_HOUSEHOLD_ID, quotes: new Map(), purchaseIds: [], walletBalance: async () => 100_000_000n, buyer: { fetchImpl: pf.fetchImpl } };
    return { ctx, pf };
  }
  type Discovered = { providers: { provider_id: string; verified: boolean; verification_problems: string[]; paid_endpoint: { path: string } | null; offer: string }[]; discovered_via: string };

  it("fetches the registry and each provider's document, and verifies them", async () => {
    const { ctx, pf } = await ctxWith();
    const r = (await callTool(ctx, "discover_services", { utility: "data" })) as Discovered;
    expect(pf.calls.map((c) => c.url)).toEqual(["/api/providers", "/api/providers/prv_demo_data/service", "/api/providers/prv_demo_datalink/service"]);
    expect(r.providers.map((p) => [p.provider_id, p.verified])).toEqual([["prv_demo_data", true], ["prv_demo_datalink", true]]);
    expect(r.providers[1]!.paid_endpoint?.path).toBe("/api/providers/prv_demo_datalink/purchase");
    expect(r.discovered_via).toMatch(/published service document/);
  });

  it("discovery is free: it creates no quote, purchase or payment and changes no device", async () => {
    const { ctx, pf } = await ctxWith();
    const before = await database.select().from(s.utilityBalances);
    await callTool(ctx, "discover_services", { utility: "electricity" });
    expect(pf.calls.every((c) => c.kind === "discovery")).toBe(true);
    expect(await database.select().from(s.providerQuotes)).toHaveLength(0);
    expect(await database.select().from(s.purchases)).toHaveLength(0);
    expect(await database.select().from(s.utilityBalances)).toEqual(before);
  });

  it("a provider publishing a different payee is marked unverified and cannot be quoted or paid", async () => {
    const { ctx } = await ctxWith({ service: (id, d) => (id === "prv_demo_powergrid" ? { ...d, payment: { ...(d.payment as object), payTo: TEST_KEYS.agent.publicKey() } } : d) });
    const r = (await callTool(ctx, "discover_services", { utility: "electricity" })) as Discovered;
    const pg = r.providers.find((p) => p.provider_id === "prv_demo_powergrid")!;
    expect(pg.verified).toBe(false);
    expect(pg.verification_problems.join(" ")).toMatch(/registered wallet/);
    const q = (await callTool(ctx, "request_quote", { utility: "electricity", provider_id: "prv_demo_powergrid", product_code: "elec_3000" })) as { error?: string };
    expect(q.error).toMatch(/failed verification/);
    const ok = (await callTool(ctx, "request_quote", { utility: "electricity", provider_id: "prv_demo_electricity", product_code: "elec_3000" })) as { quote_id?: string };
    expect(ok.quote_id).toMatch(/^qt_/); // the honest provider is still payable
  });

  it("a provider whose document is unavailable is reported, not trusted", async () => {
    const { ctx } = await ctxWith({ service: (id, d) => (id === "prv_demo_topuphub" ? new Response("down", { status: 503 }) : d) });
    const r = (await callTool(ctx, "discover_services", { utility: "airtime" })) as Discovered;
    const hub = r.providers.find((p) => p.provider_id === "prv_demo_topuphub")!;
    expect(hub.verified).toBe(false);
    expect(hub.verification_problems.join(" ")).toMatch(/unavailable/);
  });
});
