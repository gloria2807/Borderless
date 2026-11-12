/**
 * Spending authority — deterministic, pure, and the ONLY place that decides whether
 * money may be spent. Evaluated when a purchase is created AND again immediately
 * before signing. No LLM or client input can override it.
 */
import type { MobileNetwork, PaymentStatus, PurchaseStage, UtilityKind } from "../db/schema";

export interface PolicyRules {
  autoPurchaseEnabled: boolean;
  perPurchaseLimitNgn: number;
  overallAgentLimitNgn: number;
  manualApprovalThresholdNgn: number;
  approvedServices: UtilityKind[];
  approvedNetworks: MobileNetwork[];
  approvedProviderIds: string[];
}

export interface BudgetRules {
  amountNgn: number;
  priorSpendNgn: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface PurchaseLedgerEntry {
  id: string;
  amountNgn: number;
  initiatedBy: "agent" | "owner" | "script";
  stage: PurchaseStage;
  paymentStatus: PaymentStatus;
  createdAt: Date;
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

export interface PurchaseIntent {
  kind: UtilityKind;
  providerId: string;
  providerAvailable: boolean;
  network: MobileNetwork | null;
  amountNgn: number;
  initiatedBy: "agent" | "owner" | "script";
  /** The owner explicitly approved this specific purchase. */
  ownerApproved?: boolean;
}

export type ViolationCode =
  | "agent_disabled"
  | "service_not_approved"
  | "provider_not_approved"
  | "network_not_approved"
  | "provider_unavailable"
  | "exceeds_per_purchase_limit"
  | "exceeds_budget"
  | "exceeds_agent_authority"
  | "budget_period_inactive";

export interface Violation {
  code: ViolationCode;
  message: string;
}

export interface AuthorityResult {
  outcome: "allow" | "require_approval" | "deny";
  violations: Violation[];
  summary: BudgetSummary;
}

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

export function evaluateSpendingAuthority(
  intent: PurchaseIntent,
  policy: PolicyRules,
  budget: BudgetRules,
  ledger: PurchaseLedgerEntry[],
  now: Date,
  excludePurchaseId?: string,
): AuthorityResult {
  const summary = summariseBudget(budget, policy, ledger, excludePurchaseId);
  const v: Violation[] = [];
  const agentInitiated = intent.initiatedBy !== "owner";

  if (now < budget.periodStart || now >= budget.periodEnd) {
    v.push({ code: "budget_period_inactive", message: "There is no active budget period. Set a budget before Borderless can spend." });
  }
  if (agentInitiated && !policy.autoPurchaseEnabled && !intent.ownerApproved) {
    v.push({ code: "agent_disabled", message: "Automatic purchasing is turned off." });
  }
  if (!policy.approvedServices.includes(intent.kind)) {
    v.push({ code: "service_not_approved", message: `${intent.kind} is not an approved service.` });
  }
  if (!policy.approvedProviderIds.includes(intent.providerId)) {
    v.push({ code: "provider_not_approved", message: "This provider is not approved." });
  }
  if (intent.kind !== "electricity" && (!intent.network || !policy.approvedNetworks.includes(intent.network))) {
    v.push({ code: "network_not_approved", message: "This mobile network is not approved." });
  }
  if (!intent.providerAvailable) {
    v.push({ code: "provider_unavailable", message: "The provider is currently unavailable." });
  }
  if (intent.amountNgn > policy.perPurchaseLimitNgn) {
    v.push({
      code: "exceeds_per_purchase_limit",
      message: `${naira(intent.amountNgn)} is above the ${naira(policy.perPurchaseLimitNgn)} per-purchase limit.`,
    });
  }
  if (intent.amountNgn > summary.remainingNgn) {
    v.push({
      code: "exceeds_budget",
      message: `${naira(intent.amountNgn)} is more than the ${naira(summary.remainingNgn)} left in the budget.`,
    });
  }
  if (agentInitiated && intent.amountNgn > summary.agentAuthorityRemainingNgn) {
    v.push({
      code: "exceeds_agent_authority",
      message: `${naira(intent.amountNgn)} is more than the ${naira(summary.agentAuthorityRemainingNgn)} of spending authority Borderless has left.`,
    });
  }

  if (v.length) return { outcome: "deny", violations: v, summary };
  if (agentInitiated && !intent.ownerApproved && intent.amountNgn > policy.manualApprovalThresholdNgn) {
    return { outcome: "require_approval", violations: [], summary };
  }
  return { outcome: "allow", violations: [], summary };
}
