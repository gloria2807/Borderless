/**
 * Demo pricing: maps a simulated NGN purchase value to a Stellar TESTNET USDC amount.
 *
 * This is a fixed configuration value (DEMO_NGN_PER_TESTNET_USDC), not an exchange
 * rate. Testnet USDC has no monetary value. The UI must always label it as such.
 */
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";

export const TESTNET_USDC = {
  code: "USDC",
  network: "stellar:testnet" as const,
  /** SEP-41 Stellar Asset Contract for Circle testnet USDC. */
  contract: USDC_TESTNET_ADDRESS,
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  decimals: 7,
};

/** NGN (integer naira) → atomic testnet USDC units (7 decimals), rounded up. */
export function ngnToTestnetUsdcAtomic(amountNgn: number, ngnPerUsdc: number): bigint {
  if (!Number.isInteger(amountNgn) || amountNgn <= 0) throw new Error("amountNgn must be a positive integer");
  if (!Number.isInteger(ngnPerUsdc) || ngnPerUsdc <= 0) throw new Error("ngnPerUsdc must be a positive integer");
  const numerator = BigInt(amountNgn) * 10n ** BigInt(TESTNET_USDC.decimals);
  const denominator = BigInt(ngnPerUsdc);
  return (numerator + denominator - 1n) / denominator;
}

export function formatAtomic(atomic: bigint | string, decimals = TESTNET_USDC.decimals): string {
  const value = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac.length < 2 ? frac.padEnd(2, "0") : frac}` : `${whole}.00`;
}
