/**
 * Reads the payment wallet's testnet USDC balance from Horizon (public data only).
 * Returns null when the balance cannot be read — callers must treat that as
 * "do not sign" (fail closed), never as "probably fine".
 */
import { env } from "../config/env";
import { decimalToAtomic } from "./horizon";
import { TESTNET_USDC } from "./pricing";

export type WalletBalanceReader = (address: string) => Promise<bigint | null>;

/** Balance plus whether the account can hold testnet USDC at all (has the trustline). */
export async function readUsdcWallet(address: string): Promise<{ balanceAtomic: bigint; trustline: boolean } | null> {
  try {
    const base = env().STELLAR_HORIZON_URL.replace(/\/+$/, "");
    const res = await fetch(`${base}/accounts/${address}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const acc = (await res.json()) as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
    const line = acc.balances.find((b) => b.asset_code === TESTNET_USDC.code && b.asset_issuer === TESTNET_USDC.issuer);
    return line ? { balanceAtomic: decimalToAtomic(line.balance), trustline: true } : { balanceAtomic: 0n, trustline: false };
  } catch {
    return null;
  }
}

export const readUsdcBalanceAtomic: WalletBalanceReader = async (address) => (await readUsdcWallet(address))?.balanceAtomic ?? null;
