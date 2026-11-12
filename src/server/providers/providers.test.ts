import { describe, expect, it } from "vitest";
import { airtimeProduct, airtimeProvider } from "./airtime";
import { dataProduct, dataProvider } from "./data";
import { demoElectricityToken, electricityProduct, electricityProvider } from "./electricity";
import { PROVIDER_MODULES } from "./registry";
import { ProductError, type AccountRow, type BalanceRow } from "./types";

const NOW = new Date("2026-11-14T06:00:00Z");
const HOUR = 3_600_000;
const TX = "a".repeat(64);

const account = (o: Partial<AccountRow>): AccountRow => ({
  id: "acc", householdId: "hh", kind: "airtime", providerId: "prv", label: "x", identifier: "+2348030000417", network: "mtn", createdAt: NOW, ...o,
});
const balance = (o: Partial<BalanceRow>): BalanceRow => ({
  accountId: "acc", balance: 0, unit: "MB", baselineUsagePerHour: 1, usageMultiplier: 1, expiresAt: null, activeBundle: null, updatedAt: NOW, ...o,
});

describe("registry", () => {
  it("registers one module per utility with unique provider ids", () => {
    const ids = Object.values(PROVIDER_MODULES).map((m) => m.definition.id);
    expect(new Set(ids).size).toBe(3);
    for (const [kind, m] of Object.entries(PROVIDER_MODULES)) expect(m.definition.kind).toBe(kind);
  });
  it("every listed product resolves back to itself (catalogue is self-consistent)", () => {
    for (const m of Object.values(PROVIDER_MODULES)) {
      for (const p of m.listProducts()) {
        expect(m.resolveProduct(m.definition.kind === "data" ? { productCode: p.code } : { amountNgn: p.amountNgn })).toEqual(p);
      }
    }
  });
});

describe("electricity provider", () => {
  it("vends at the demo tariff, rounding units down", () => {
    expect(electricityProduct(3_000)).toMatchObject({ quantity: 13.3, unit: "kWh", amountNgn: 3_000 });
  });
  it("enforces minimum, maximum and ₦500 steps", () => {
    for (const bad of [750, 1_250, 25_000, Number.NaN]) expect(() => electricityProduct(bad)).toThrow(ProductError);
  });
  it("validates 11-digit meter numbers and rejects a mobile network", () => {
    const acc = account({ kind: "electricity", identifier: "45012345678", network: null });
    expect(electricityProvider.validateOrder({ accountIdentifier: "45012345678" }, acc)).toBeNull();
    expect(electricityProvider.validateOrder({ accountIdentifier: "4501234" }, acc)?.code).toBe("invalid_meter_number");
    expect(electricityProvider.validateOrder({ accountIdentifier: "45012345678", network: "mtn" }, acc)?.code).toBe("unexpected_network");
  });
  it("credits the meter and issues a deterministic 20-digit demo token", () => {
    const out = electricityProvider.fulfil({ product: electricityProduct(3_000), balance: balance({ balance: 8, unit: "kWh" }), txHash: TX, simNow: NOW });
    expect(out.balanceAfter).toBe(21.3);
    expect(out.demoToken).toMatch(/^\d{4}(-\d{4}){4}$/);
    expect(out.demoToken).toBe(demoElectricityToken(TX));
    expect(demoElectricityToken("b".repeat(64))).not.toBe(out.demoToken);
  });
});

describe("airtime provider", () => {
  it("recharges the exact naira amount", () => {
    expect(airtimeProduct(500)).toMatchObject({ quantity: 500, unit: "NGN" });
    expect(() => airtimeProduct(50)).toThrow(ProductError);
    expect(() => airtimeProduct(150)).toThrow(ProductError);
  });
  it("requires a +234 number on the line's registered network", () => {
    const acc = account({});
    expect(airtimeProvider.validateOrder({ accountIdentifier: "+2348030000417", network: "mtn" }, acc)).toBeNull();
    expect(airtimeProvider.validateOrder({ accountIdentifier: "08030000417", network: "mtn" }, acc)?.code).toBe("invalid_msisdn");
    expect(airtimeProvider.validateOrder({ accountIdentifier: "+2348030000417", network: "airtel" }, acc)?.code).toBe("network_mismatch");
    expect(airtimeProvider.validateOrder({ accountIdentifier: "+2348030000417" }, acc)?.code).toBe("network_mismatch");
  });
  it("credits the phone and returns a recharge reference", () => {
    const out = airtimeProvider.fulfil({ product: airtimeProduct(500), balance: balance({ balance: 200, unit: "NGN" }), txHash: TX, simNow: NOW });
    expect(out.balanceAfter).toBe(700);
    expect(out.details.reference).toBe("BDLAAAAAAAAAA");
    expect(out.demoToken).toBeNull();
  });
});

describe("data provider", () => {
  const bundle = dataProduct("data_1_5gb_30d");

  it("sells bundles by code only", () => {
    expect(() => dataProduct("data_free_unlimited")).toThrow(ProductError);
    expect(dataProvider.validateOrder({ accountIdentifier: "+2348030000417", network: "mtn", amountNgn: 1000 }, account({ kind: "data" }))?.code).toBe("unexpected_amount");
  });

  it("stacks on an active bundle and keeps the later expiry", () => {
    const longExpiry = new Date(NOW.getTime() + 60 * 24 * HOUR);
    const out = dataProvider.fulfil({ product: bundle, balance: balance({ balance: 150, expiresAt: longExpiry }), txHash: TX, simNow: NOW });
    expect(out.balanceAfter).toBe(1_686);
    expect(out.deviceUpdate?.expiresAt).toEqual(longExpiry);
    expect(out.details.stackedOnActiveBundle).toBe(true);
  });

  it("extends expiry when the new bundle outlasts the active one", () => {
    const soon = new Date(NOW.getTime() + 2 * HOUR);
    const out = dataProvider.fulfil({ product: bundle, balance: balance({ balance: 150, expiresAt: soon }), txHash: TX, simNow: NOW });
    expect(out.deviceUpdate?.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 24 * HOUR));
    expect(out.deviceUpdate?.activeBundle).toBe("1.5 GB · 30 days");
  });

  it("forfeits data left on an expired bundle", () => {
    const expired = new Date(NOW.getTime() - HOUR);
    const out = dataProvider.fulfil({ product: bundle, balance: balance({ balance: 150, expiresAt: expired }), txHash: TX, simNow: NOW });
    expect(out.balanceAfter).toBe(1_536);
    expect(out.details.forfeitedExpiredMb).toBe(150);
  });
});
