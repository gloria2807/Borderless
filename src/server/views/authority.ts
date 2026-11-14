/**
 * The owner's spending authority, broken down so the different limits are never confused:
 * household budget, this period's agent authority, today's agent budget, the per-task budget,
 * the per-request limits, pending commitments and the wallet's actual testnet balance.
 *
 * Read-only and computed from the same rules and ledger the policy engine uses. The policy engine
 * remains the only thing that decides whether a payment may be signed.
 */
import { and, eq } from "drizzle-orm";
import { env } from "../config/env";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { isFaultEnabled } from "../demo/faults";
import { isCommitted, startOfHouseholdDay, summariseBudget, type PurchaseLedgerEntry } from "../household/policy";
import { loadHousehold } from "../household/state";
import { readUsdcBalanceAtomic } from "../payments/wallet";
import type { AccountEligibilityInput } from "../providers/registry";

export async function accountEligibilityInputs(db: Database, householdId: string): Promise<Partial<Record<UtilityKind, AccountEligibilityInput>>> {
  const rows = await db.select().from(s.utilityAccounts).where(eq(s.utilityAccounts.householdId, householdId));
  return Object.fromEntries(rows.map((a) => [a.kind, { kind: a.kind, network: a.network, distributionCompany: a.distributionCompany }]));
}

export interface AuthorityRow {
  key: "household" | "period" | "daily" | "task" | "auto" | "request" | "wallet";
  label: string;
  limitNgn: number | null;
  usedNgn: number | null;
  remainingNgn: number | null;
  note: string;
}

export interface SpendingAuthorityView {
  ngnPerUsdc: number;
  rows: AuthorityRow[];
  pendingNgn: number;
  /** What Borderless could spend on one purchase right now, before approval is needed. */
  spendableAutoNgn: number;
  /** What one purchase could reach with the owner's approval. */
  spendableMaxNgn: number;
  bindingConstraint: string;
  wallet: { address: string | null; balanceNgn: number | null; balanceUsdc: string | null; emptyDemoWallet: boolean };
  paused: boolean;
  autoPurchaseEnabled: boolean;
}

const PAID = new Set(["settled", "confirmed"]);
const counts = (e: PurchaseLedgerEntry) => PAID.has(e.paymentStatus) || isCommitted(e);

// Wallet balance comes from Horizon; a short cache keeps page renders fast.
const cache = globalThis as unknown as { __borderlessWallet?: { at: number; address: string; atomic: bigint | null } };
async function walletAtomic(address: string): Promise<bigint | null> {
  const hit = cache.__borderlessWallet;
  if (hit && hit.address === address && Date.now() - hit.at < 15_000) return hit.atomic;
  const atomic = await readUsdcBalanceAtomic(address).catch(() => null);
  cache.__borderlessWallet = { at: Date.now(), address, atomic };
  return atomic;
}

export async function spendingAuthority(db: Database, householdId: string, opts: { walletBalance?: (address: string) => Promise<bigint | null> } = {}): Promise<SpendingAuthorityView> {
  const st = await loadHousehold(db, householdId);
  const p = st.policy;
  const rate = env().DEMO_NGN_PER_TESTNET_USDC;
  const summary = summariseBudget(st.budget, p, st.ledger);
  const now = st.household.simulatedNow;
  const dayStart = startOfHouseholdDay(now);
  const agent = st.ledger.filter((e) => e.initiatedBy !== "owner" && counts(e));
  const usedToday = agent.filter((e) => e.createdAt >= dayStart).reduce((t, e) => t + e.amountNgn, 0);

  const emptyDemoWallet = await isFaultEnabled("agent_wallet_empty");
  const address = (emptyDemoWallet ? env().DEMO_EMPTY_WALLET_PUBLIC : env().AGENT_STELLAR_PUBLIC) ?? null;
  const atomic = address ? await (opts.walletBalance ?? walletAtomic)(address) : null;
  const walletNgn = atomic === null ? null : Number((atomic * BigInt(rate)) / 10_000_000n);

  const householdRemaining = Math.max(0, summary.remainingNgn - (p.reserveNgn ?? 0));
  const dailyRemaining = p.dailyAgentBudgetNgn === undefined ? Infinity : Math.max(0, p.dailyAgentBudgetNgn - usedToday);
  const task = p.taskBudgetNgn ?? Infinity;
  const caps: [string, number][] = [
    ["the household budget", householdRemaining],
    ["this period's agent authority", summary.agentAuthorityRemainingNgn],
    ["today's agent budget", dailyRemaining],
    ["the per-task budget", task],
    ["the largest single request", p.perPurchaseLimitNgn],
    ["the wallet's testnet balance", walletNgn ?? Infinity],
  ];
  const [bindingLabel, spendableMaxNgn] = caps.reduce((a, b) => (b[1] < a[1] ? b : a));
  const spendableAutoNgn = Math.min(spendableMaxNgn, p.manualApprovalThresholdNgn);

  const rows: AuthorityRow[] = [
    { key: "household", label: "Household budget", limitNgn: st.budget.amountNgn, usedNgn: st.budget.priorSpendNgn + summary.spentNgn, remainingNgn: summary.remainingNgn, note: `${st.budget.period === "weekly" ? "This week" : "This month"}, everyone's purchases.` },
    { key: "period", label: "Borderless's authority this period", limitNgn: p.overallAgentLimitNgn, usedNgn: summary.agentSpentNgn + summary.agentCommittedNgn, remainingNgn: summary.agentAuthorityRemainingNgn, note: "Only the agent's purchases count." },
    { key: "daily", label: "Daily spending budget", limitNgn: p.dailyAgentBudgetNgn ?? null, usedNgn: usedToday, remainingNgn: Number.isFinite(dailyRemaining) ? dailyRemaining : null, note: "Resets at midnight, household time." },
    { key: "task", label: "Per-task budget", limitNgn: p.taskBudgetNgn ?? null, usedNgn: null, remainingNgn: null, note: "Each agent run starts with this much." },
    { key: "auto", label: "Automatic, per request", limitNgn: p.manualApprovalThresholdNgn, usedNgn: null, remainingNgn: null, note: "Above this, Borderless asks you first." },
    { key: "request", label: "Largest single request", limitNgn: p.perPurchaseLimitNgn, usedNgn: null, remainingNgn: null, note: "Refused above this, even with approval." },
    {
      key: "wallet",
      label: "Agent wallet (Stellar testnet)",
      limitNgn: null,
      usedNgn: null,
      remainingNgn: walletNgn,
      note: atomic === null ? "Balance couldn't be read from Horizon right now." : emptyDemoWallet ? "Demo fault: paying from the empty demo wallet." : "Live balance from Horizon. Policy can never spend more than this.",
    },
  ];

  return {
    ngnPerUsdc: rate,
    rows,
    pendingNgn: summary.committedNgn,
    spendableAutoNgn: Math.max(0, spendableAutoNgn),
    spendableMaxNgn: Math.max(0, Number.isFinite(spendableMaxNgn) ? spendableMaxNgn : 0),
    bindingConstraint: bindingLabel,
    wallet: { address, balanceNgn: walletNgn, balanceUsdc: atomic === null ? null : (Number(atomic) / 1e7).toFixed(2), emptyDemoWallet },
    paused: !!p.agentPaused,
    autoPurchaseEnabled: p.autoPurchaseEnabled,
  };
}

/** Accounts helper for callers that only need one utility's eligibility input. */
export async function accountFor(db: Database, householdId: string, kind: UtilityKind) {
  const [a] = await db.select().from(s.utilityAccounts).where(and(eq(s.utilityAccounts.householdId, householdId), eq(s.utilityAccounts.kind, kind)));
  return a ?? null;
}
