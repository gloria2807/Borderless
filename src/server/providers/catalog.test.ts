import { describe, expect, it } from "vitest";
import { airtimeProduct, dataProduct, electricityProduct, ProductError } from "./catalog";
import { demoElectricityToken } from "./fulfilment";

describe("provider catalogue", () => {
  it("prices electricity at the demo tariff, rounding units down", () => {
    expect(electricityProduct(3_000)).toMatchObject({ quantity: 13.3, unit: "kWh", amountNgn: 3_000 });
  });
  it("enforces provider minimums, maximums and steps", () => {
    expect(() => electricityProduct(750)).toThrow(ProductError);
    expect(() => electricityProduct(1_250)).toThrow(ProductError);
    expect(() => electricityProduct(25_000)).toThrow(ProductError);
    expect(() => airtimeProduct(50)).toThrow(ProductError);
    expect(() => dataProduct("data_free_unlimited")).toThrow(ProductError);
  });
  it("resolves data bundles by code", () => {
    expect(dataProduct("data_1_5gb_30d")).toMatchObject({ quantity: 1_536, unit: "MB", amountNgn: 1_000 });
  });
  it("derives a stable 20-digit demo token from the settlement hash", () => {
    const token = demoElectricityToken("a".repeat(64));
    expect(token).toMatch(/^\d{4}(-\d{4}){4}$/);
    expect(demoElectricityToken("a".repeat(64))).toBe(token);
    expect(demoElectricityToken("b".repeat(64))).not.toBe(token);
  });
});
