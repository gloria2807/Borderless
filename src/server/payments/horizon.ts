/**
 * Independent confirmation of an x402 settlement on Stellar testnet via Horizon.
 * We do not take the facilitator's or provider's word for it: the transaction must
 * exist, be successful, and contain a USDC transfer from our payer to the expected
 * provider for the expected amount.
 */
import { env } from "../config/env";
import { TESTNET_USDC } from "./pricing";

export interface ExpectedTransfer {
  txHash: string;
  from: string;
  to: string;
  amountAtomic: bigint;
}

export type HorizonConfirmation =
  | { status: "confirmed"; ledger: number; closedAt: string; transferVerified: true }
  | { status: "not_found" }
  | { status: "failed_on_chain"; ledger: number }
  | { status: "mismatch"; ledger: number; reason: string }
  | { status: "unreachable"; reason: string };

interface BalanceChange {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  type: string;
  from?: string;
  to?: string;
  amount: string;
}

/** "0.0300000" → 300000n (7 decimals). */
export function decimalToAtomic(value: string, decimals = TESTNET_USDC.decimals): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function confirmOnHorizon(
  expected: ExpectedTransfer,
  opts: { attempts?: number; delayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HorizonConfirmation> {
  const base = env().STELLAR_HORIZON_URL.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 8;
  let lastError = "";

  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(opts.delayMs ?? 1_500);
    try {
      const res = await doFetch(`${base}/transactions/${expected.txHash}`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) {
        lastError = "not yet ingested";
        continue; // Horizon ingestion can lag the RPC by a ledger or two.
      }
      if (!res.ok) {
        lastError = `Horizon HTTP ${res.status}`;
        continue;
      }
      const tx = (await res.json()) as { successful: boolean; ledger: number; created_at: string };
      if (!tx.successful) return { status: "failed_on_chain", ledger: tx.ledger };

      const opsRes = await doFetch(`${base}/transactions/${expected.txHash}/operations?limit=20`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!opsRes.ok) {
        lastError = `Horizon operations HTTP ${opsRes.status}`;
        continue;
      }
      const ops = (await opsRes.json()) as { _embedded: { records: { asset_balance_changes?: BalanceChange[] }[] } };
      const changes = ops._embedded.records.flatMap((r) => r.asset_balance_changes ?? []);
      const match = changes.find(
        (c) =>
          c.type === "transfer" &&
          c.asset_code === TESTNET_USDC.code &&
          c.asset_issuer === TESTNET_USDC.issuer &&
          c.from === expected.from &&
          c.to === expected.to,
      );
      if (!match) {
        return { status: "mismatch", ledger: tx.ledger, reason: "No USDC transfer from the agent wallet to the provider was found in this transaction." };
      }
      if (decimalToAtomic(match.amount) !== expected.amountAtomic) {
        return { status: "mismatch", ledger: tx.ledger, reason: `Transferred ${match.amount} USDC, expected a different amount.` };
      }
      return { status: "confirmed", ledger: tx.ledger, closedAt: tx.created_at, transferVerified: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return lastError === "not yet ingested" ? { status: "not_found" } : { status: "unreachable", reason: lastError };
}

export function explorerTxUrl(txHash: string): string {
  return `${env().STELLAR_EXPLORER_TX_URL.replace(/\/+$/, "")}/${txHash}`;
}
