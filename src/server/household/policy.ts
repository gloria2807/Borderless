/**
 * Spending authority — deterministic, pure, and the ONLY place that decides whether
 * money may be spent. Evaluated when a purchase is proposed, when it is created, and
 * again immediately before signing. No model output or client input can override it.
 *
 * Checks run in a fixed, documented order and every evaluation returns the full trace,
 * so each decision can be audited after the fact:
 *
 *   0  Automatic purchasing is on (agent purchases only)
 *   1  Provider is approved and available
 *   2  Utility category is allowed
 *   3  Recipient is a known household account on an approved network
 *   4  Quote is valid and unchanged
 *   5  Amount is within the per-request cap (and the per-utility cap, if set)
 *   6  The run's task budget has room
 *   7  The agent's daily budget has room
 *   8  The household budget has room, after the reserve and pending commitments
 *   9  The payment wallet holds enough testnet USDC
 *  10  Whether the owner must approve
 */
import type { MobileNetwork, PaymentStatus, PurchaseStage, UtilityKind, ServiceType } from "../db/schema";

export interface PolicyRules {
  autoPurchaseEnabled: boolean;
  perPurchaseLimitNgn: number;
  overallAgentLimitNgn: number;
  manualApprovalThresholdNgn: number;
  /** How long a parked purchase waits for the owner before it expires unpaid. */
  approvalTtlSeconds?: number;
  approvedServices: UtilityKind[];
  approvedNetworks: MobileNetwork[];
  approvedProviderIds: string[];
  /** Optional limits; when undefined the check reports "not configured" and passes. */
  dailyAgentBudgetNgn?: number;
  taskBudgetNgn?: number;
  reserveNgn?: number;
  /** Most the agent may pay for one information service. */
  intelligenceCapNgn?: number;
  maxPerUtilityNgn?: Partial<Record<UtilityKind, number>>;
}

export interface BudgetRules {
  amountNgn: number;
  priorSpendNgn: number;
  periodStart: Date;
  periodEnd: Date;
  period?: "weekly" | "monthly";
}

export interface PurchaseLedgerEntry {
  id: string;
  amountNgn: number;
  initiatedBy: "agent" | "owner" | "script";
  stage: PurchaseStage;
  paymentStatus: PaymentStatus;
  /** Simulated time the purchase was made. */
  createdAt: Date;
  runId?: string | null;
}

export interface BudgetSummary {
  budgetNgn: number;
  priorSpendNgn: number;
  /** Paid (settled or confirmed) in this period. */
  spentNgn: number;
  /** Not yet paid but not failed/cancelled — reserved against the budget. */
  committedNgn: number;
  remainingNgn: number;
  agentSpentNgn: number;
  agentCommittedNgn: number;
  agentAuthorityRemainingNgn: number;
}

const PAID: PaymentStatus[] = ["settled", "confirmed"];
const isAgent = (e: PurchaseLedgerEntry) => e.initiatedBy !== "owner";

export function isCommitted(e: Pick<PurchaseLedgerEntry, "stage" | "paymentStatus">): boolean {
  if (PAID.includes(e.paymentStatus)) return false;
  if (e.paymentStatus === "failed") return false;
  return e.stage !== "failed" && e.stage !== "cancelled";
}

/** Counts towards a limit if paid or still committed. */
const counts = (e: PurchaseLedgerEntry) => PAID.includes(e.paymentStatus) || isCommitted(e);

export function summariseBudget(
  budget: BudgetRules,
  policy: Pick<PolicyRules, "overallAgentLimitNgn">,
  ledger: PurchaseLedgerEntry[],
  excludePurchaseId?: string,
): BudgetSummary {
  const entries = ledger.filter((e) => e.id !== excludePurchaseId);
  const sum = (xs: PurchaseLedgerEntry[]) => xs.reduce((t, e) => t + e.amountNgn, 0);
  const paid = entries.filter((e) => PAID.includes(e.paymentStatus));
  const committed = entries.filter(isCommitted);
  const spentNgn = sum(paid);
  const committedNgn = sum(committed);
  const agentSpentNgn = sum(paid.filter(isAgent));
  const agentCommittedNgn = sum(committed.filter(isAgent));
  return {
    budgetNgn: budget.amountNgn,
    priorSpendNgn: budget.priorSpendNgn,
    spentNgn,
    committedNgn,
    remainingNgn: Math.max(0, budget.amountNgn - budget.priorSpendNgn - spentNgn - committedNgn),
    agentSpentNgn,
    agentCommittedNgn,
    agentAuthorityRemainingNgn: Math.max(0, policy.overallAgentLimitNgn - agentSpentNgn - agentCommittedNgn),
  };
}

/** Start of the simulated household day (WAT, UTC+1) containing `now`. */
export function startOfHouseholdDay(now: Date): Date {
  const shifted = now.getTime() + 3_600_000;
  return new Date(shifted - (shifted % 86_400_000) - 3_600_000);
}

export interface PurchaseIntent {
  kind: UtilityKind;
  providerId: string;
  providerAvailable: boolean;
  network: MobileNetwork | null;
  amountNgn: number;
  initiatedBy: "agent" | "owner" | "script";
  /** The owner explicitly approved this specific purchase. */
  ownerApproved?: boolean;
  /** What is bought: utility credit (default) or an information service. */
  serviceType?: ServiceType;
}

/** Facts the caller has verified against the database / chain, fed in as plain data. */
export interface PolicyEvidence {
  /** The agent run proposing this purchase (enables the task budget check). */
  runId?: string;
  /** Recipient (meter / MSISDN) checked against the household's accounts. */
  recipient?: { permitted: boolean; detail: string };
  /** Quote checked for expiry and for matching price, product and payee. */
  quote?: { valid: boolean; detail: string };
  /** Wallet check: null availableAtomic means the balance could not be read. */
  wallet?: { availableAtomic: bigint | null; requiredAtomic: bigint };
}

export type ViolationCode =
  | "agent_disabled"
  | "service_not_approved"
  | "provider_not_approved"
  | "network_not_approved"
  | "provider_unavailable"
  | "recipient_not_permitted"
  | "quote_invalid"
  | "exceeds_per_purchase_limit"
  | "exceeds_utility_limit"
  | "exceeds_intelligence_cap"
  | "exceeds_task_budget"
  | "exceeds_daily_budget"
  | "exceeds_budget"
  | "exceeds_reserve"
  | "exceeds_agent_authority"
  | "budget_period_inactive"
  | "insufficient_wallet_balance"
  | "wallet_unverified";

export interface Violation {
  code: ViolationCode;
  message: string;
}

export type CheckStatus = "pass" | "fail" | "skip" | "approval";

export interface PolicyCheck {
  step: number;
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface AuthorityResult {
  outcome: "allow" | "require_approval" | "deny";
  violations: Violation[];
  summary: BudgetSummary;
  /** The full, ordered audit trace. */
  checks: PolicyCheck[];
}

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const usdc = (atomic: bigint) => (Number(atomic) / 1e7).toFixed(4);

export function evaluateSpendingAuthority(
  intent: PurchaseIntent,
  policy: PolicyRules,
  budget: BudgetRules,
  ledger: PurchaseLedgerEntry[],
  now: Date,
  excludePurchaseId?: string,
  evidence: PolicyEvidence = {},
): AuthorityResult {
  const summary = summariseBudget(budget, policy, ledger, excludePurchaseId);
  const others = ledger.filter((e) => e.id !== excludePurchaseId);
  const agentInitiated = intent.initiatedBy !== "owner";
  const checks: PolicyCheck[] = [];
  const violations: Violation[] = [];
  const amount = intent.amountNgn;

  const check = (step: number, key: string, label: string, ok: boolean | "skip", detail: string, failures: Violation[] = []) => {
    checks.push({ step, key, label, status: ok === "skip" ? "skip" : ok ? "pass" : "fail", detail });
    if (ok === false) violations.push(...failures);
  };

  // 0 — authority switch
  if (agentInitiated) {
    const on = policy.autoPurchaseEnabled || !!intent.ownerApproved;
    check(0, "authority", "Automatic purchasing is on", on, on ? "The owner has granted purchasing authority." : "The owner has turned automatic purchasing off.", [
      { code: "agent_disabled", message: "Automatic purchasing is turned off." },
    ]);
  } else {
    check(0, "authority", "Automatic purchasing is on", "skip", "Owner purchase: the owner acts directly.");
  }

  // 1 — provider
  const providerApproved = policy.approvedProviderIds.includes(intent.providerId);
  const providerFails: Violation[] = [];
  if (!providerApproved) providerFails.push({ code: "provider_not_approved", message: "This provider is not approved." });
  if (!intent.providerAvailable) providerFails.push({ code: "provider_unavailable", message: "The provider is currently unavailable." });
  check(1, "provider", "Provider is approved and available", providerFails.length === 0,
    providerFails.length ? providerFails.map((v) => v.message).join(" ") : `${intent.providerId} is on the approved list and available.`, providerFails);

  // 2 — category
  const categoryOk = policy.approvedServices.includes(intent.kind);
  check(2, "category", "Utility category is allowed", categoryOk, categoryOk ? `${intent.kind} is an approved service.` : `${intent.kind} is not an approved service.`, [
    { code: "service_not_approved", message: `${intent.kind} is not an approved service.` },
  ]);

  // 3 — recipient
  const recipientFails: Violation[] = [];
  if (evidence.recipient && !evidence.recipient.permitted) recipientFails.push({ code: "recipient_not_permitted", message: evidence.recipient.detail });
  if (intent.kind !== "electricity" && (!intent.network || !policy.approvedNetworks.includes(intent.network))) {
    recipientFails.push({ code: "network_not_approved", message: "This mobile network is not approved." });
  }
  check(3, "recipient", "Recipient is a permitted household account", recipientFails.length === 0,
    recipientFails.length ? recipientFails.map((v) => v.message).join(" ") : evidence.recipient?.detail ?? "Recipient is the household's registered account.", recipientFails);

  // 4 — quote
  if (evidence.quote) {
    check(4, "quote", "Quote is valid and unchanged", evidence.quote.valid, evidence.quote.detail, [{ code: "quote_invalid", message: evidence.quote.detail }]);
  } else {
    check(4, "quote", "Quote is valid and unchanged", "skip", "Priced from the provider's published catalogue.");
  }

  // 5 — per-request cap (+ per-utility cap)
  const capFails: Violation[] = [];
  if (amount > policy.perPurchaseLimitNgn) {
    capFails.push({ code: "exceeds_per_purchase_limit", message: `${naira(amount)} is above the ${naira(policy.perPurchaseLimitNgn)} per-purchase limit.` });
  }
  // Information purchases have their own cap; utility credit has the per-utility cap.
  const information = (intent.serviceType ?? "utility_topup") !== "utility_topup";
  const utilityCap = information ? (policy.intelligenceCapNgn ?? 1000) : policy.maxPerUtilityNgn?.[intent.kind];
  if (utilityCap !== undefined && amount > utilityCap) {
    capFails.push(
      information
        ? { code: "exceeds_intelligence_cap", message: `${naira(amount)} is above the ${naira(utilityCap)} limit for one information purchase.` }
        : { code: "exceeds_utility_limit", message: `${naira(amount)} is above the ${naira(utilityCap)} limit for ${intent.kind}.` },
    );
  }
  check(5, "per_request_cap", "Within the per-request cap", capFails.length === 0,
    capFails.length ? capFails.map((v) => v.message).join(" ") : `${naira(amount)} ≤ ${naira(Math.min(policy.perPurchaseLimitNgn, utilityCap ?? Infinity))}${information ? " (information purchase)" : ""}.`, capFails);

  // 6 — task budget (agent runs only)
  if (!agentInitiated || !evidence.runId || policy.taskBudgetNgn === undefined) {
    check(6, "task_budget", "Task budget has room", "skip", !agentInitiated ? "Owner purchase." : !evidence.runId ? "Not part of an agent run." : "No task budget configured.");
  } else {
    const usedByRun = others.filter((e) => e.runId === evidence.runId && counts(e)).reduce((t, e) => t + e.amountNgn, 0);
    const ok = usedByRun + amount <= policy.taskBudgetNgn;
    check(6, "task_budget", "Task budget has room", ok, `${naira(usedByRun)} used by this run; ${naira(amount)} more against a ${naira(policy.taskBudgetNgn)} task budget.`, [
      { code: "exceeds_task_budget", message: `This would take the run past its ${naira(policy.taskBudgetNgn)} task budget (${naira(usedByRun)} already used).` },
    ]);
  }

  // 7 — daily budget (agent only, simulated household day)
  if (!agentInitiated || policy.dailyAgentBudgetNgn === undefined) {
    check(7, "daily_budget", "Daily agent budget has room", "skip", !agentInitiated ? "Owner purchase." : "No daily budget configured.");
  } else {
    const dayStart = startOfHouseholdDay(now);
    const usedToday = others.filter((e) => isAgent(e) && counts(e) && e.createdAt >= dayStart).reduce((t, e) => t + e.amountNgn, 0);
    const ok = usedToday + amount <= policy.dailyAgentBudgetNgn;
    check(7, "daily_budget", "Daily agent budget has room", ok, `${naira(usedToday)} spent or committed today; ${naira(amount)} more against ${naira(policy.dailyAgentBudgetNgn)}.`, [
      { code: "exceeds_daily_budget", message: `This would take today's agent spending past ${naira(policy.dailyAgentBudgetNgn)} (${naira(usedToday)} already).` },
    ]);
  }

  // 8 — household budget, reserve, overall agent authority
  const budgetFails: Violation[] = [];
  if (now < budget.periodStart || now >= budget.periodEnd) {
    budgetFails.push({ code: "budget_period_inactive", message: "There is no active budget period. Set a budget before Borderless can spend." });
  }
  const reserve = policy.reserveNgn ?? 0;
  if (amount > summary.remainingNgn) {
    budgetFails.push({ code: "exceeds_budget", message: `${naira(amount)} is more than the ${naira(summary.remainingNgn)} left in the budget.` });
  } else if (agentInitiated && amount > summary.remainingNgn - reserve) {
    budgetFails.push({ code: "exceeds_reserve", message: `${naira(amount)} would dip into the ${naira(reserve)} reserve (${naira(summary.remainingNgn)} left).` });
  }
  if (agentInitiated && amount > summary.agentAuthorityRemainingNgn) {
    budgetFails.push({
      code: "exceeds_agent_authority",
      message: `${naira(amount)} is more than the ${naira(summary.agentAuthorityRemainingNgn)} of spending authority Borderless has left.`,
    });
  }
  check(8, "household_budget", "Household budget has room", budgetFails.length === 0,
    budgetFails.length
      ? budgetFails.map((v) => v.message).join(" ")
      : `${naira(summary.remainingNgn)} left (incl. ${naira(summary.committedNgn)} committed elsewhere)${reserve ? `, ${naira(reserve)} reserve kept` : ""}.`,
    budgetFails);

  // 9 — wallet balance
  if (!evidence.wallet) {
    check(9, "wallet_balance", "Wallet holds enough testnet USDC", "skip", "Checked immediately before signing.");
  } else if (evidence.wallet.availableAtomic === null) {
    check(9, "wallet_balance", "Wallet holds enough testnet USDC", false, "The wallet balance could not be read, so nothing will be signed.", [
      { code: "wallet_unverified", message: "The payment wallet's balance could not be verified." },
    ]);
  } else {
    const ok = evidence.wallet.availableAtomic >= evidence.wallet.requiredAtomic;
    check(9, "wallet_balance", "Wallet holds enough testnet USDC", ok,
      `${usdc(evidence.wallet.availableAtomic)} available, ${usdc(evidence.wallet.requiredAtomic)} needed.`, [
        { code: "insufficient_wallet_balance", message: `The payment wallet holds ${usdc(evidence.wallet.availableAtomic)} testnet USDC; ${usdc(evidence.wallet.requiredAtomic)} is needed.` },
      ]);
  }

  // 10 — approval
  const needsApproval = agentInitiated && !intent.ownerApproved && amount > policy.manualApprovalThresholdNgn;
  if (violations.length) {
    checks.push({ step: 10, key: "approval", label: "Owner approval", status: "skip", detail: "Not reached: an earlier rule refused the purchase." });
    return { outcome: "deny", violations, summary, checks };
  }
  checks.push({
    step: 10,
    key: "approval",
    label: "Owner approval",
    status: needsApproval ? "approval" : "pass",
    detail: needsApproval
      ? `${naira(amount)} is above the ${naira(policy.manualApprovalThresholdNgn)} approval threshold.`
      : intent.ownerApproved
        ? "Approved by the owner."
        : !agentInitiated
          ? "Owner purchase."
          : `${naira(amount)} is within the ${naira(policy.manualApprovalThresholdNgn)} approval threshold.`,
  });
  return { outcome: needsApproval ? "require_approval" : "allow", violations: [], summary, checks };
}
