import { describe, expect, it } from "vitest";
import { decimalToAtomic } from "./horizon";
import { formatAtomic, ngnToTestnetUsdcAtomic } from "./pricing";

describe("demo pricing", () => {
  it("maps NGN to atomic testnet USDC at the configured demo rate", () => {
    expect(ngnToTestnetUsdcAtomic(3_000, 100_000)).toBe(300_000n); // 0.03 USDC
    expect(ngnToTestnetUsdcAtomic(500, 100_000)).toBe(50_000n);
  });
  it("rounds up so the provider is never underpaid", () => {
    expect(ngnToTestnetUsdcAtomic(1, 3)).toBe(3_333_334n);
  });
  it("rejects non-integer and non-positive amounts", () => {
    expect(() => ngnToTestnetUsdcAtomic(0, 100_000)).toThrow();
    expect(() => ngnToTestnetUsdcAtomic(10.5, 100_000)).toThrow();
  });
  it("formats and parses atomic amounts symmetrically", () => {
    expect(formatAtomic(300_000n)).toBe("0.03");
    expect(formatAtomic("10000000")).toBe("1.00");
    expect(decimalToAtomic("0.0300000")).toBe(300_000n);
    expect(decimalToAtomic("12.5")).toBe(125_000_000n);
  });
});
