/**
 * Funding guard — a network-enforced spending ceiling for the agent wallet.
 *
 * x402's `exact` scheme makes the payer sign a transfer from ITS OWN balance, so a
 * token allowance cannot gate an x402 payment directly. Instead, the household treasury
 * grants the agent ("float") wallet a USDC allowance through the Stellar Asset Contract:
 *
 *   approve(from = treasury, spender = float, amount = cap, expiration_ledger)
 *
 * When the float is short before a payment, Borderless draws a top-up with
 *
 *   transfer_from(spender = float, from = treasury, to = float, amount)
 *
 * Stellar — not Borderless — rejects any draw beyond the cap or after the expiry, and
 * the owner can revoke at any time (approve 0). If the agent key leaked, the most it
 * could ever move is the float balance plus the remaining allowance until expiry.
 *
 * What it does NOT do: restrict where the float pays (a destination allowlist) or cap
 * individual x402 payments. Those stay with the policy engine.
 */
import { Address, BASE_FEE, Contract, Keypair, nativeToScVal, Networks, rpc, scValToNative, TransactionBuilder, type xdr } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { agentSecret, env, treasurySecret } from "../config/env";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import { formatAtomic, TESTNET_USDC } from "./pricing";

/** Testnet closes a ledger about every 5 seconds. */
export const SECONDS_PER_LEDGER = 5;

export class FundingGuardError extends Error {
  constructor(
    readonly code: "not_configured" | "allowance_exceeded" | "allowance_expired_or_revoked" | "insufficient_treasury" | "network_error" | "rejected",
    message: string,
  ) {
    super(message);
  }
}

export interface FundingGuardStatus {
  configured: boolean;
  treasury: string | null;
  spender: string | null;
  /** Allowance left right now, read on-chain (0 when expired or revoked). */
  allowanceAtomic: string | null;
  treasuryBalanceAtomic: string | null;
  latestLedger: number | null;
  grant: { capAtomic: string; expirationLedger: number; grantedAt: string; grantTxHash: string; revokedAt: string | null; revokeTxHash: string | null } | null;
  /** Estimated wall-clock expiry from the ledger gap. */
  expiresAtEstimate: string | null;
  error: string | null;
}

/** Injectable surface so the buyer can be tested without the network. */
export interface FundingSource {
  /** Top the float up so it can cover `requiredAtomic`. Returns the draw, or null if none was needed or possible. */
  ensureFloat(requiredAtomic: bigint, availableAtomic: bigint | null): Promise<{ amountAtomic: bigint; txHash: string } | null>;
}

const server = () => new rpc.Server(env().SOROBAN_RPC_URL, { allowHttp: env().SOROBAN_RPC_URL.startsWith("http://") });
const usdc = () => new Contract(TESTNET_USDC.contract);
const addr = (g: string) => new Address(g).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });

function keys() {
  const t = treasurySecret();
  if (!t) return null;
  const treasury = Keypair.fromSecret(t);
  const float = Keypair.fromSecret(agentSecret());
  return { treasury, float };
}

export function fundingGuardConfigured(): boolean {
  try {
    return keys() !== null;
  } catch {
    return false;
  }
}

/** Read-only contract call (simulation only, nothing is submitted). */
async function readContract(source: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
  const srv = server();
  const account = await srv.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).addOperation(usdc().call(method, ...args)).setTimeout(30).build();
  const sim = await srv.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new FundingGuardError("network_error", `Could not read ${method} from the USDC contract.`);
  return scValToNative(sim.result.retval);
}

/** Build, simulate (Stellar enforces the allowance here), sign and submit a contract call. */
async function invoke(signer: Keypair, method: string, args: xdr.ScVal[]): Promise<string> {
  const srv = server();
  const account = await srv.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).addOperation(usdc().call(method, ...args)).setTimeout(60).build();
  let prepared;
  try {
    prepared = await srv.prepareTransaction(tx);
  } catch (err) {
    throw classify(err);
  }
  prepared.sign(signer);
  const sent = await srv.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new FundingGuardError("rejected", `The network rejected the ${method} transaction.`);
  for (let i = 0; i < 30; i++) {
    const got = await srv.getTransaction(sent.hash);
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) throw new FundingGuardError("rejected", `The ${method} transaction failed on-chain (${sent.hash}).`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new FundingGuardError("network_error", `Timed out waiting for the ${method} transaction (${sent.hash}).`);
}

/**
 * Map a failed simulation to a plain reason. The USDC Stellar Asset Contract reports
 * `Error(Contract, #9)` when an allowance is insufficient (also after expiry or revocation)
 * and `#10` when the balance is insufficient.
 */
function classify(err: unknown): FundingGuardError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Error\(Contract, #9\)/.test(msg)) return new FundingGuardError("allowance_exceeded", "Stellar refused the draw: it exceeds the allowance left (or the allowance expired or was revoked).");
  if (/Error\(Contract, #10\)/.test(msg)) return new FundingGuardError("insufficient_treasury", "Stellar refused the draw: the treasury does not hold enough testnet USDC.");
  return new FundingGuardError("rejected", `Simulation failed: ${msg.slice(0, 300)}`);
}

export async function readAllowanceAtomic(treasury: string, spender: string): Promise<bigint> {
  return BigInt(String(await readContract(spender, "allowance", [addr(treasury), addr(spender)])));
}

export async function readUsdcBalanceViaContract(holder: string): Promise<bigint> {
  return BigInt(String(await readContract(holder, "balance", [addr(holder)])));
}

/** Grant (or replace) the allowance. Signed by the treasury. */
export async function grantAllowance(db: Database, householdId: string, capAtomic: bigint, days: number): Promise<{ txHash: string; expirationLedger: number }> {
  const k = keys();
  if (!k) throw new FundingGuardError("not_configured", "Funding guard needs TREASURY_STELLAR_SECRET (run `pnpm wallets:setup`).");
  const latest = (await server().getLatestLedger()).sequence;
  const expirationLedger = latest + Math.round((days * 86_400) / SECONDS_PER_LEDGER);
  const txHash = await invoke(k.treasury, "approve", [addr(k.treasury.publicKey()), addr(k.float.publicKey()), i128(capAtomic), u32(expirationLedger)]);
  const row = { householdId, treasury: k.treasury.publicKey(), spender: k.float.publicKey(), capAtomic: capAtomic.toString(), expirationLedger, grantedAt: new Date(), grantTxHash: txHash, revokedAt: null, revokeTxHash: null, updatedAt: new Date() };
  await db.insert(s.fundingGuards).values(row).onConflictDoUpdate({ target: s.fundingGuards.householdId, set: row });
  return { txHash, expirationLedger };
}

/** Revoke: approve 0. The next draw fails at simulation; nothing reaches the network. */
export async function revokeAllowance(db: Database, householdId: string): Promise<{ txHash: string }> {
  const k = keys();
  if (!k) throw new FundingGuardError("not_configured", "Funding guard is not configured.");
  const latest = (await server().getLatestLedger()).sequence;
  const txHash = await invoke(k.treasury, "approve", [addr(k.treasury.publicKey()), addr(k.float.publicKey()), i128(0n), u32(latest)]);
  await db.update(s.fundingGuards).set({ revokedAt: new Date(), revokeTxHash: txHash, updatedAt: new Date() }).where(eq(s.fundingGuards.householdId, householdId));
  return { txHash };
}

/** Draw from the treasury into the float. Signed by the float (the spender). */
export async function drawFromTreasury(amountAtomic: bigint): Promise<{ txHash: string }> {
  const k = keys();
  if (!k) throw new FundingGuardError("not_configured", "Funding guard is not configured.");
  const txHash = await invoke(k.float, "transfer_from", [addr(k.float.publicKey()), addr(k.treasury.publicKey()), addr(k.float.publicKey()), i128(amountAtomic)]);
  return { txHash };
}

export async function fundingGuardStatus(db: Database, householdId: string): Promise<FundingGuardStatus> {
  const empty: FundingGuardStatus = { configured: false, treasury: null, spender: null, allowanceAtomic: null, treasuryBalanceAtomic: null, latestLedger: null, grant: null, expiresAtEstimate: null, error: null };
  let k: ReturnType<typeof keys>;
  try {
    k = keys();
  } catch {
    k = null;
  }
  if (!k) return empty;
  const [g] = await db.select().from(s.fundingGuards).where(eq(s.fundingGuards.householdId, householdId));
  const base: FundingGuardStatus = {
    ...empty,
    configured: true,
    treasury: k.treasury.publicKey(),
    spender: k.float.publicKey(),
    grant: g
      ? { capAtomic: g.capAtomic, expirationLedger: g.expirationLedger, grantedAt: g.grantedAt.toISOString(), grantTxHash: g.grantTxHash, revokedAt: g.revokedAt?.toISOString() ?? null, revokeTxHash: g.revokeTxHash }
      : null,
  };
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The Stellar RPC did not answer in time.")), 8000));
    const [allowance, balance, latest] = await Promise.race([
      Promise.all([readAllowanceAtomic(k.treasury.publicKey(), k.float.publicKey()), readUsdcBalanceViaContract(k.treasury.publicKey()), server().getLatestLedger()]),
      timeout,
    ]);
    const ledgersLeft = g && !g.revokedAt ? g.expirationLedger - latest.sequence : null;
    return {
      ...base,
      allowanceAtomic: allowance.toString(),
      treasuryBalanceAtomic: balance.toString(),
      latestLedger: latest.sequence,
      expiresAtEstimate: ledgersLeft !== null && ledgersLeft > 0 ? new Date(Date.now() + ledgersLeft * SECONDS_PER_LEDGER * 1000).toISOString() : null,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * How much to draw: at least the shortfall, up to the float target, never more than the
 * allowance left. Throws when the allowance cannot cover the shortfall. Pure.
 */
export function planTopUp(requiredAtomic: bigint, availableAtomic: bigint, allowanceAtomic: bigint, targetAtomic: bigint): bigint {
  if (availableAtomic >= requiredAtomic) return 0n;
  if (allowanceAtomic <= 0n) throw new FundingGuardError("allowance_expired_or_revoked", "The agent wallet is short and the Funding guard allowance is used up, expired or revoked.");
  const shortfall = requiredAtomic - availableAtomic;
  const wanted = targetAtomic - availableAtomic > shortfall ? targetAtomic - availableAtomic : shortfall;
  const amount = wanted < allowanceAtomic ? wanted : allowanceAtomic;
  if (amount < shortfall) {
    throw new FundingGuardError("allowance_exceeded", `The agent wallet needs ${formatAtomic(shortfall)} more test USDC but only ${formatAtomic(allowanceAtomic)} is left in the Funding guard allowance.`);
  }
  return amount;
}

/**
 * The live funding source used by the buyer: when the float cannot cover a payment,
 * draw enough to reach the configured float target (at least the shortfall), never more
 * than the allowance left. Stellar enforces the cap regardless of this arithmetic.
 */
export const treasuryFunding: FundingSource = {
  async ensureFloat(requiredAtomic, availableAtomic) {
    if (!fundingGuardConfigured() || availableAtomic === null || availableAtomic >= requiredAtomic) return null;
    const k = keys()!;
    const allowance = await readAllowanceAtomic(k.treasury.publicKey(), k.float.publicKey());
    const target = BigInt(Math.round(env().FUNDING_GUARD_FLOAT_TARGET_USDC * 10 ** TESTNET_USDC.decimals));
    const amount = planTopUp(requiredAtomic, availableAtomic, allowance, target);
    const { txHash } = await drawFromTreasury(amount);
    return { amountAtomic: amount, txHash };
  },
};
