/**
 * Competing providers (upgrade M3). Two demo providers per utility, each with its own
 * catalogue, pricing and receiving wallet. Proves:
 *  - the decision input and the agent's tools see every provider that can serve the account;
 *  - the engine picks on value, and falls back to another approved provider on outage;
 *  - provider approval and network support are enforced per provider;
 *  - quotes are bound to the provider that issued them and its registered wallet.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { decide } from "@/server/agent/engine";
import { explain } from "@/server/agent/explain";
import { buildDecisionInput } from "@/server/agent/run";
import { createRun } from "@/server/agent/runtime/run-log";
import { callTool, type ToolContext } from "@/server/agent/runtime/tools";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_HOUSEHOLD_ID, DEMO_ACCOUNTS, seedDemoHousehold, wipeAll } from "@/server/household/seed";
import { executePurchase } from "@/server/payments/x402-buyer";
import { DEFAULT_PROVIDER, providerPayTo, providersFor } from "@/server/providers/registry";
import { handleQuoteRequest, type ProviderQuote } from "@/server/providers/quote-handler";
import { createPurchase } from "@/server/transactions/purchases";
import { configureTestEnv, freshDatabase, TEST_KEYS } from "./helpers";
import { paymentRequiredHeader, providerFetch } from "./provider-fetch";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

async function scenario(id: string) {
  await wipeAll(database);
  await seedDemoHousehold(database, id);
}

const providersOf = (kind: s.UtilityKind) => providersFor(kind).map((m) => m.definition.id);

describe("registry", () => {
  it("has two providers per utility, each with its own wallet", () => {
    expect(providersOf("electricity")).toEqual(["prv_demo_electricity", "prv_demo_powergrid"]);
    expect(providersOf("airtime")).toEqual(["prv_demo_airtime", "prv_demo_topuphub"]);
    expect(providersOf("data")).toEqual(["prv_demo_data", "prv_demo_datalink"]);
    expect(providerPayTo("prv_demo_powergrid")).toBe(TEST_KEYS.powergrid);
    expect(providerPayTo("prv_demo_topuphub")).toBe(TEST_KEYS.topuphub);
    expect(providerPayTo("prv_demo_datalink")).toBe(TEST_KEYS.datalink);
    expect(new Set(providersFor("electricity").map((m) => providerPayTo(m.definition.id))).size).toBe(2);
  });
});

describe("decision engine across providers", () => {
  it("considers every provider that serves the account", async () => {
    const input = await buildDecisionInput(database, DEMO_HOUSEHOLD_ID);
    for (const kind of ["electricity", "airtime", "data"] as const) {
      expect(new Set(input.products[kind].map((p) => p.providerId))).toEqual(new Set(providersOf(kind)));
    }
  });

  it("picks on value: the cheaper electricity (₦210/kWh) and the better data bundle", async () => {
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    const by = Object.fromEntries(d.selected.map((p) => [p.kind, p.product]));
    expect(by.electricity?.providerId).toBe("prv_demo_powergrid");
    expect(by.data?.providerId).toBe("prv_demo_datalink");
  });

  it("prefers the provider that delivers more when two charge the same price", async () => {
    await scenario("budget-covers-one");
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected).toHaveLength(1);
    expect(d.selected[0]!.product).toMatchObject({ providerId: "prv_demo_powergrid", amountNgn: 2000 });
  });

  it("falls back to the other approved provider during an outage (provider-outage scenario)", async () => {
    await scenario("provider-outage");
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected.map((p) => [p.kind, p.product.providerId])).toEqual([["electricity", "prv_demo_electricity"]]);
    // Every PowerGrid candidate was refused by policy because of the outage.
    const pg = d.candidates.filter((c) => c.product.providerId === "prv_demo_powergrid");
    expect(pg.length).toBeGreaterThan(0);
    expect(pg.every((c) => c.authority === "deny" && c.violations.some((v) => v.code === "provider_unavailable"))).toBe(true);
    expect(explain(d).reasoning).toContain("Demo PowerGrid Vend is unavailable right now, so I'm buying from Demo Prepaid Electricity.");
  });

  it("defers as provider_unavailable only when every provider is down", async () => {
    await scenario("provider-outage");
    await database.update(s.utilityProviders).set({ available: false }).where(eq(s.utilityProviders.kind, "electricity"));
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected).toHaveLength(0);
    expect(d.deferred).toEqual([expect.objectContaining({ kind: "electricity", reason: "provider_unavailable" })]);
  });

  it("never buys from a provider the owner has not approved", async () => {
    await database.update(s.agentPolicies).set({ approvedProviderIds: ["prv_demo_electricity", "prv_demo_airtime", "prv_demo_data"] });
    const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
    expect(d.selected.length).toBeGreaterThan(0);
    expect(d.selected.every((p) => ["prv_demo_electricity", "prv_demo_airtime", "prv_demo_data"].includes(p.product.providerId))).toBe(true);
  });

  it("excludes providers that do not serve the line's network", async () => {
    await database.update(s.utilityAccounts).set({ network: "t2" }).where(eq(s.utilityAccounts.id, DEMO_ACCOUNTS.airtime));
    const input = await buildDecisionInput(database, DEMO_HOUSEHOLD_ID);
    expect(new Set(input.products.airtime.map((p) => p.providerId))).toEqual(new Set(["prv_demo_airtime"]));
  });
});

describe("agent tools across providers", () => {
  const ctx = (): ToolContext => ({ db: database, runId: "run_test", householdId: DEMO_HOUSEHOLD_ID, quotes: new Map(), purchaseIds: [], walletBalance: async () => 100_000_000n, buyer: { fetchImpl: providerFetch().fetchImpl } });
  beforeEach(async () => {
    const id = await createRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "ai", model: "t", task: "t", trigger: "manual", simTime: new Date() });
    await database.update(s.agentRuns).set({ id: "run_test" }).where(eq(s.agentRuns.id, id));
  });

  it("discover_providers lists both providers with live availability and labels provider text untrusted", async () => {
    await database.update(s.utilityProviders).set({ available: false }).where(eq(s.utilityProviders.id, "prv_demo_powergrid"));
    const r = (await callTool(ctx(), "discover_providers", { utility: "electricity" })) as { providers: { provider_id: string; available: boolean; approved_by_owner: boolean }[]; note: string };
    expect(r.providers.map((p) => [p.provider_id, p.available, p.approved_by_owner])).toEqual([
      ["prv_demo_electricity", true, true],
      ["prv_demo_powergrid", false, true],
    ]);
    expect(r.note).toMatch(/untrusted/);
  });

  it("compare_offers ranks products from every provider", async () => {
    const r = (await callTool(ctx(), "compare_offers", { utility: "data" })) as { offers: { provider_id: string; product_code: string }[] };
    expect(new Set(r.offers.map((o) => o.provider_id))).toEqual(new Set(["prv_demo_data", "prv_demo_datalink"]));
  });

  it("request_quote is bound to the chosen provider and its registered wallet", async () => {
    const r = (await callTool(ctx(), "request_quote", { utility: "data", provider_id: "prv_demo_datalink", product_code: "dl_2gb_14d" })) as { provider_id: string; price_ngn: number; quote_id: string };
    expect(r).toMatchObject({ provider_id: "prv_demo_datalink", price_ngn: 900 });
    const [row] = await database.select().from(s.providerQuotes).where(eq(s.providerQuotes.id, r.quote_id));
    expect(row).toMatchObject({ providerId: "prv_demo_datalink", payTo: TEST_KEYS.datalink, amountNgn: 900 });
  });

  it("refuses a product code from the wrong provider, an unknown provider, or one that cannot serve the line", async () => {
    const c = ctx();
    expect(await callTool(c, "request_quote", { utility: "data", provider_id: "prv_demo_data", product_code: "dl_2gb_14d" })).toMatchObject({ error: expect.stringMatching(/Unknown product_code/) });
    expect(await callTool(c, "request_quote", { utility: "data", provider_id: "prv_demo_powergrid", product_code: "elec_2000" })).toMatchObject({ error: expect.stringMatching(/Unknown provider_id/) });
    await database.update(s.utilityAccounts).set({ network: "glo" }).where(eq(s.utilityAccounts.id, DEMO_ACCOUNTS.airtime));
    expect(await callTool(c, "request_quote", { utility: "airtime", provider_id: "prv_demo_topuphub", product_code: "air_1000" })).toMatchObject({ error: expect.stringMatching(/cannot serve/) });
    expect(c.quotes.size).toBe(0);
  });

  it("an unavailable provider issues no quote; the agent can still quote the other one", async () => {
    await database.update(s.utilityProviders).set({ available: false }).where(eq(s.utilityProviders.id, "prv_demo_powergrid"));
    const c = ctx();
    const down = (await callTool(c, "request_quote", { utility: "electricity", provider_id: "prv_demo_powergrid", product_code: "elec_3000" })) as { error?: string };
    expect(down.error).toMatch(/did not issue a quote/);
    const up = (await callTool(c, "request_quote", { utility: "electricity", provider_id: "prv_demo_electricity", product_code: "elec_3000" })) as { provider_id: string };
    expect(up.provider_id).toBe("prv_demo_electricity");
  });

  it("a quote whose payee is another provider's wallet is refused before any purchase", async () => {
    const c = ctx();
    const q = (await callTool(c, "request_quote", { utility: "electricity", provider_id: "prv_demo_powergrid", product_code: "elec_3000" })) as { quote_id: string };
    c.quotes.get(q.quote_id)!.payTo = TEST_KEYS.electricity; // a real provider wallet, but not PowerGrid's
    const r = (await callTool(c, "purchase_utility", { quote_id: q.quote_id, reason: "Restore power." })) as { status: string; reason: string };
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/registered wallet/);
    expect(await database.select().from(s.purchases)).toHaveLength(0);
  });
});

describe("buyer pays the provider that issued the quote", () => {
  it("refuses a 402 that names a different provider's wallet (never signs)", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 3000, providerId: "prv_demo_powergrid", initiatedBy: "script" });
    expect(p.providerId).toBe("prv_demo_powergrid");
    const pf = providerFetch({
      purchase: (_req, body) =>
        new Response("{}", {
          status: 402,
          headers: {
            "payment-required": paymentRequiredHeader({
              scheme: "exact",
              network: "stellar:testnet",
              asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
              amount: "300000",
              payTo: TEST_KEYS.electricity, // the OTHER electricity provider
              maxTimeoutSeconds: 60,
              extra: { areFeesSponsored: true, quoteId: body.quoteId },
            }),
          },
        }),
    });
    const r = await executePurchase(database, p.id, { fetchImpl: pf.fetchImpl, walletBalance: async () => 100_000_000n });
    expect(r).toMatchObject({ stage: "failed", paymentStatus: "failed" });
    expect(pf.purchases()).toHaveLength(1); // the 402 only — never a signed retry
    const quotes = pf.quotes();
    expect(quotes[0]!.url).toBe("/api/providers/prv_demo_powergrid/quote");
  });

  it("manual purchases still default to the account's provider", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "airtime", amountNgn: 500, initiatedBy: "owner" });
    expect(p.providerId).toBe(DEFAULT_PROVIDER.airtime.definition.id);
  });

  it("TopUp Hub credits its 3% bonus from ₦1,000", async () => {
    const res = await handleQuoteRequest(
      providersFor("airtime")[1]!,
      new Request("http://provider.test/api/providers/prv_demo_topuphub/quote", { method: "POST", body: JSON.stringify({ accountIdentifier: "+2348030000417", network: "mtn", amountNgn: 1000 }) }),
    );
    expect(res.status).toBe(200);
    const q = (await res.json()) as ProviderQuote;
    expect(q.product).toMatchObject({ quantity: 1030, unit: "NGN" });
    expect(q.payment.payTo).toBe(TEST_KEYS.topuphub);
  });
});
