import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as purchaseAction } from "@/app/api/purchases/[id]/[action]/route";
import { PUT as putSettings } from "@/app/api/settings/route";
import { env, resetEnvCache } from "@/server/config/env";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_HOUSEHOLD_ID } from "@/server/household/seed";
import { periodFor, settingsSchema } from "@/server/settings";
import { createPurchase } from "@/server/transactions/purchases";
import { getHouseholdOverview, getPurchaseDetail } from "@/server/views/household";
import { configureTestEnv, freshDatabase } from "./helpers";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const VALID = {
  householdName: "Okafor Household",
  budgetAmountNgn: 20_000,
  budgetPeriod: "monthly",
  autoPurchaseEnabled: false,
  perPurchaseLimitNgn: 3_000,
  overallAgentLimitNgn: 6_000,
  manualApprovalThresholdNgn: 2_000,
  priorities: ["data", "electricity", "airtime"],
  approvedServices: ["electricity", "data"],
  approvedNetworks: ["mtn", "airtel"],
};

const put = (body: unknown, headers: Record<string, string> = {}) =>
  putSettings(new Request("http://localhost:3001/api/settings", { method: "PUT", headers: { "content-type": "application/json", host: "localhost:3001", ...headers }, body: JSON.stringify(body) }), {
    params: Promise.resolve({}),
  });

describe("same-origin protection", () => {
  it("rejects cross-site requests to mutating routes", async () => {
    const res = await put(VALID, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
  });
  it("accepts same-origin requests", async () => {
    expect((await put(VALID, { origin: "http://localhost:3001" })).status).toBe(200);
  });
});

describe("settings", () => {
  it("saves the owner's rules, revokes authority and logs the change", async () => {
    expect((await put(VALID)).status).toBe(200);
    const o = await getHouseholdOverview(DEMO_HOUSEHOLD_ID);
    expect(o.household.name).toBe("Okafor Household");
    expect(o.policy).toMatchObject({ autoPurchaseEnabled: false, perPurchaseLimitNgn: 3_000, approvedNetworks: ["mtn", "airtel"] });
    expect(o.policy.approvedProviderIds).toEqual(["prv_demo_electricity", "prv_demo_powergrid", "prv_demo_data", "prv_demo_datalink"]);
    expect(o.priorities).toEqual(["data", "electricity", "airtime"]);
    const [ev] = await database.select().from(s.activityEvents).where(eq(s.activityEvents.type, "settings.updated"));
    expect(ev?.detail).toMatch(/automatic purchasing turned off/);
  });
  it("rejects invalid input", async () => {
    expect((await put({ ...VALID, priorities: ["data", "data", "airtime"] })).status).toBe(400);
    expect((await put({ ...VALID, perPurchaseLimitNgn: -5 })).status).toBe(400);
    expect((await put({ ...VALID, approvedNetworks: ["vodafone"] })).status).toBe(400);
    expect(settingsSchema.safeParse(VALID).success).toBe(true);
  });
  it("computes budget periods", () => {
    const now = new Date("2026-11-14T06:00:00Z"); // Saturday
    expect(periodFor("monthly", now)).toEqual({ start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") });
    expect(periodFor("weekly", now)).toEqual({ start: new Date("2026-11-09T00:00:00Z"), end: new Date("2026-11-16T00:00:00Z") });
  });
});

describe("purchase actions", () => {
  const call = (id: string, action: string) =>
    purchaseAction(new Request(`http://localhost:3001/api/purchases/${id}/${action}`, { method: "POST" }), { params: Promise.resolve({ id, action }) });

  it("refuses to approve a purchase that is not awaiting approval", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 1_000, initiatedBy: "agent" });
    const res = await call(p.id, "approve");
    expect(res.status).toBe(409);
  });
  it("declines a parked purchase without paying", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 4_500, initiatedBy: "agent" });
    expect((await call(p.id, "decline")).status).toBe(200);
    const detail = await getPurchaseDetail(DEMO_HOUSEHOLD_ID, p.id);
    expect(detail?.purchase).toMatchObject({ stage: "cancelled", paymentStatus: "not_started" });
    expect(detail?.payment).toBeNull();
  });
  it("404s unknown purchases and rejects malformed ids", async () => {
    expect((await call("pur_0000000000zzzz", "approve")).status).toBe(404);
    expect((await call("../../etc", "approve")).status).toBe(400);
  });
});

describe("configuration", () => {
  it("defaults the provider base URL to this server's own port", () => {
    delete process.env.APP_BASE_URL;
    process.env.PORT = "3001";
    resetEnvCache();
    expect(env().APP_BASE_URL).toBe("http://localhost:3001");
    delete process.env.PORT;
  });
  it("refuses any network other than Stellar testnet", () => {
    process.env.STELLAR_NETWORK = "stellar:pubnet";
    resetEnvCache();
    expect(() => env()).toThrow(/Invalid server configuration/);
    delete process.env.STELLAR_NETWORK;
    resetEnvCache();
  });
});
