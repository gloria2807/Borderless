/**
 * Borderless decision engine — deterministic and pure.
 *
 * Given a snapshot of the household (device readings, forecasts, budget, policy,
 * priorities, open purchases, provider availability, catalogue) it decides what,
 * if anything, to buy. It never spends: it produces a plan that the orchestrator
 * executes through the same spending-authority gate the payment layer enforces.
 *
 * Every candidate is evaluated with `evaluateSpendingAuthority`, so the engine can
 * never plan a purchase the backend would refuse.
 */
import type { MobileNetwork, PurchaseStage, UtilityKind } from "../db/schema";
import {
  evaluateSpendingAuthority,
  summariseBudget,
  type BudgetRules,
  type PolicyRules,
  type PurchaseLedgerEntry,
  type Violation,
  type ViolationCode,
} from "../household/policy";
import type { Product } from "../providers/types";
import type { Forecast, UrgencyLevel } from "../usage/forecast";

// ── Tunables (documented, deliberate) ───────────────────────────────────────

/** Hours of service a purchase should ideally restore. */
export const PREFERRED_COVERAGE_HOURS: Record<UtilityKind, number> = { electricity: 5 * 24, data: 7 * 24, airtime: 7 * 24 };
/** A purchase must restore at least this much service to count as a fix. */
export const MINIMUM_COVERAGE_HOURS = 48;

const URGENCY_SCORE: Record<UrgencyLevel, number> = { critical: 100, low: 60, watch: 20, ok: 0 };
const PRIORITY_STEP = 15;

// ── Types ───────────────────────────────────────────────────────────────────

export interface UtilitySnapshot {
  kind: UtilityKind;
  accountId: string;
  providerId: string;
  providerName: string;
  providerAvailable: boolean;
  network: MobileNetwork | null;
  forecast: Forecast;
  openPurchase: { id: string; stage: PurchaseStage; amountNgn: number } | null;
}

export interface DecisionInput {
  now: Date;
  utilities: UtilitySnapshot[];
  priorities: UtilityKind[];
  policy: PolicyRules;
  budget: BudgetRules;
  ledger: PurchaseLedgerEntry[];
  products: Record<UtilityKind, Product[]>;
}

export interface Assessment {
  kind: UtilityKind;
  urgency: UrgencyLevel;
  priorityRank: number;
  score: number;
  needsAction: boolean;
  forecast: Forecast;
}

export interface Candidate {
  kind: UtilityKind;
  product: Product;
  coverageHours: number;
  meetsMinimum: boolean;
  meetsPreferred: boolean;
  authority: "allow" | "require_approval" | "deny";
  violations: Violation[];
}

export interface PlannedPurchase {
  kind: UtilityKind;
  product: Product;
  coverageHours: number;
  requiresApproval: boolean;
  /** Restores less than the minimum coverage — best available within limits. */
  partial: boolean;
  basis: "preferred" | "best_within_limits" | "partial_relief" | "budget_shared";
  /** Budget deliberately left for these later needs when sizing this purchase. */
  reservedFor: { kind: UtilityKind; amountNgn: number }[];
}

export type DeferralReason =
  | "purchase_in_progress"
  | "unusual_usage"
  | "provider_unavailable"
  | "service_not_approved"
  | "network_not_approved"
  | "agent_disabled"
  | "insufficient_budget"
  | "insufficient_authority"
  | "over_purchase_limit"
  | "no_eligible_product";

export interface Deferral {
  kind: UtilityKind;
  reason: DeferralReason;
  /** What the agent would buy if the constraint were lifted (for the owner to consider). */
  recommendation: { product: Product; coverageHours: number } | null;
  violations: Violation[];
  /** Another utility was funded first (competition for the same budget). */
  outrankedBy: UtilityKind | null;
}

export interface Flag {
  kind: UtilityKind;
  code: "unusual_usage";
  usageRatio: number;
}

export type DecisionOutcome = "no_action" | "purchase_started" | "awaiting_approval" | "blocked" | "flagged";

export interface BudgetImpact {
  remainingBeforeNgn: number;
  plannedNgn: number;
  remainingAfterNgn: number;
  agentAuthorityBeforeNgn: number;
  agentAuthorityAfterNgn: number;
}

export interface Decision {
  now: Date;
  assessments: Assessment[];
  candidates: Candidate[];
  selected: PlannedPurchase[];
  deferred: Deferral[];
  flags: Flag[];
  outcome: DecisionOutcome;
  budgetImpact: BudgetImpact;
}

// ── Engine ──────────────────────────────────────────────────────────────────

export function assess(u: UtilitySnapshot, priorities: UtilityKind[]): Assessment {
  const rank = priorities.indexOf(u.kind);
  const priorityRank = rank === -1 ? priorities.length : rank;
  const urgency = u.forecast.urgency;
  return {
    kind: u.kind,
    urgency,
    priorityRank,
    score: URGENCY_SCORE[urgency] + Math.max(0, priorities.length - priorityRank) * PRIORITY_STEP,
    needsAction: urgency === "critical" || urgency === "low",
    forecast: u.forecast,
  };
}

/** Hours of service the device would have after buying `product`. */
export function coverageAfter(u: UtilitySnapshot, product: Product): number {
  const f = u.forecast;
  const total = Math.max(0, f.balance) + product.quantity;
  const byUse = f.ratePerHour > 0 ? total / f.ratePerHour : Number.POSITIVE_INFINITY;
  if (u.kind !== "data") return byUse;
  // Data is also bounded by validity (the later of current expiry and the new bundle's).
  const validity = Math.max(product.validityHours ?? Number.POSITIVE_INFINITY, f.hoursToExpiry ?? 0);
  return Math.min(byUse, validity);
}

function evaluateCandidates(u: UtilitySnapshot, input: DecisionInput, ledger: PurchaseLedgerEntry[]): Candidate[] {
  const preferred = PREFERRED_COVERAGE_HOURS[u.kind];
  return (input.products[u.kind] ?? []).map((product) => {
    const coverageHours = coverageAfter(u, product);
    const authority = evaluateSpendingAuthority(
      {
        kind: u.kind,
        providerId: u.providerId,
        providerAvailable: u.providerAvailable,
        network: u.network,
        amountNgn: product.amountNgn,
        initiatedBy: "agent",
      },
      input.policy,
      input.budget,
      ledger,
      input.now,
    );
    return {
      kind: u.kind,
      product,
      coverageHours,
      meetsMinimum: coverageHours >= MINIMUM_COVERAGE_HOURS,
      meetsPreferred: coverageHours >= preferred,
      authority: authority.outcome,
      violations: authority.violations,
    };
  });
}

const byPrice = (a: Candidate, b: Candidate) => a.product.amountNgn - b.product.amountNgn;
const byCoverage = (a: Candidate, b: Candidate) => b.coverageHours - a.coverageHours || byPrice(a, b);

/**
 * Product choice:
 *  1. cheapest option that reaches the preferred coverage and needs no approval;
 *  2. else the most coverage available without approval, if it reaches the minimum;
 *  3. else an option that needs owner approval (preferred first, then most coverage);
 *  4. else, if the shortage is critical, the most relief available within limits.
 */
export function choose(candidates: Candidate[], urgency: UrgencyLevel): PlannedPurchase | null {
  const allowed = candidates.filter((c) => c.authority === "allow");
  const approval = candidates.filter((c) => c.authority === "require_approval");
  const plan = (c: Candidate, basis: PlannedPurchase["basis"]): PlannedPurchase => ({
    kind: c.kind,
    product: c.product,
    coverageHours: c.coverageHours,
    requiresApproval: c.authority === "require_approval",
    partial: !c.meetsMinimum,
    basis,
    reservedFor: [],
  });

  const allowedPreferred = allowed.filter((c) => c.meetsPreferred).sort(byPrice)[0];
  if (allowedPreferred) return plan(allowedPreferred, "preferred");
  const allowedBest = allowed.filter((c) => c.meetsMinimum).sort(byCoverage)[0];
  if (allowedBest) return plan(allowedBest, "best_within_limits");

  const approvalPick = approval.filter((c) => c.meetsPreferred).sort(byPrice)[0] ?? approval.filter((c) => c.meetsMinimum).sort(byCoverage)[0];
  if (approvalPick) return plan(approvalPick, approvalPick.meetsPreferred ? "preferred" : "best_within_limits");

  if (urgency === "critical") {
    const relief = allowed.sort(byCoverage)[0];
    if (relief) return plan(relief, "partial_relief");
  }
  return null;
}

const VIOLATION_TO_DEFERRAL: Partial<Record<ViolationCode, DeferralReason>> = {
  agent_disabled: "agent_disabled",
  service_not_approved: "service_not_approved",
  provider_not_approved: "service_not_approved",
  network_not_approved: "network_not_approved",
  provider_unavailable: "provider_unavailable",
  exceeds_budget: "insufficient_budget",
  budget_period_inactive: "insufficient_budget",
  exceeds_agent_authority: "insufficient_authority",
  exceeds_per_purchase_limit: "over_purchase_limit",
};
// Most fundamental constraint first.
const DEFERRAL_ORDER: DeferralReason[] = [
  "agent_disabled",
  "service_not_approved",
  "network_not_approved",
  "provider_unavailable",
  "insufficient_budget",
  "insufficient_authority",
  "over_purchase_limit",
];

function deferralFromCandidates(candidates: Candidate[]): { reason: DeferralReason; violations: Violation[] } {
  // Explain using the cheapest product that would have restored the minimum service.
  const reference = candidates.filter((c) => c.meetsMinimum).sort(byPrice)[0] ?? [...candidates].sort(byPrice)[0];
  if (!reference) return { reason: "no_eligible_product", violations: [] };
  const reasons = reference.violations.map((v) => VIOLATION_TO_DEFERRAL[v.code]).filter((r): r is DeferralReason => !!r);
  const reason = DEFERRAL_ORDER.find((r) => reasons.includes(r)) ?? "no_eligible_product";
  return { reason, violations: reference.violations };
}

export function decide(input: DecisionInput): Decision {
  const before = summariseBudget(input.budget, input.policy, input.ledger);
  const assessments = input.utilities
    .map((u) => assess(u, input.priorities))
    .sort((a, b) => b.score - a.score || a.priorityRank - b.priorityRank);

  const ledger: PurchaseLedgerEntry[] = [...input.ledger];
  const candidates: Candidate[] = [];
  const selected: PlannedPurchase[] = [];
  const deferred: Deferral[] = [];
  const flags: Flag[] = [];

  // Needs the agent may actually buy for, in decision order (used for budget sharing).
  const actionable = assessments.filter((a) => {
    const u = input.utilities.find((x) => x.kind === a.kind)!;
    return a.needsAction && !u.openPurchase && !u.forecast.unusualUsage;
  });

  /** Cheapest no-approval option that restores the minimum service for a later need. */
  const minimumCost = (kind: UtilityKind): number | null => {
    const u = input.utilities.find((x) => x.kind === kind)!;
    const cheapest = evaluateCandidates(u, input, ledger)
      .filter((c) => c.authority === "allow" && c.meetsMinimum)
      .sort(byPrice)[0];
    return cheapest ? cheapest.product.amountNgn : null;
  };

  for (const a of assessments) {
    const u = input.utilities.find((x) => x.kind === a.kind)!;
    if (u.forecast.unusualUsage) flags.push({ kind: u.kind, code: "unusual_usage", usageRatio: u.forecast.usageRatio });
    if (!a.needsAction) continue;

    const defer = (reason: DeferralReason, extra: Partial<Deferral> = {}) =>
      deferred.push({ kind: u.kind, reason, recommendation: null, violations: [], outrankedBy: null, ...extra });

    if (u.openPurchase) {
      defer("purchase_in_progress");
      continue;
    }

    const evaluated = evaluateCandidates(u, input, ledger);
    candidates.push(...evaluated);
    let pick = choose(evaluated, a.urgency);

    // Budget sharing: if this pick would leave later needs unable to reach their
    // minimum, size this purchase down so every need gets covered where possible.
    if (pick && !pick.requiresApproval && !u.forecast.unusualUsage) {
      const later = actionable.slice(actionable.findIndex((x) => x.kind === a.kind) + 1);
      const reservedFor = later
        .map((l) => ({ kind: l.kind, amountNgn: minimumCost(l.kind) }))
        .filter((r): r is { kind: UtilityKind; amountNgn: number } => r.amountNgn !== null);
      const reserve = reservedFor.reduce((t, r) => t + r.amountNgn, 0);
      const s = summariseBudget(input.budget, input.policy, ledger);
      const available = Math.min(s.remainingNgn, s.agentAuthorityRemainingNgn);
      if (reserve > 0 && pick.product.amountNgn > available - reserve) {
        const within = evaluated
          .filter((c) => c.authority === "allow" && c.meetsMinimum && c.product.amountNgn <= available - reserve)
          .sort(byCoverage)[0];
        if (within) {
          pick = { ...pick, product: within.product, coverageHours: within.coverageHours, partial: false, basis: "budget_shared", reservedFor };
        } else {
          // Can't cover everyone: this need outranks the rest, but buy enough rather than the most.
          const enough = evaluated.filter((c) => c.authority === "allow" && c.meetsMinimum).sort(byPrice)[0];
          if (enough) pick = { ...pick, product: enough.product, coverageHours: enough.coverageHours, partial: false };
        }
      }
    }

    // Unusual consumption: do not buy more automatically — ask the owner to review first.
    if (u.forecast.unusualUsage) {
      defer("unusual_usage", { recommendation: pick ? { product: pick.product, coverageHours: pick.coverageHours } : null });
      continue;
    }

    if (pick) {
      selected.push(pick);
      ledger.push({
        id: `planned:${u.kind}`,
        amountNgn: pick.product.amountNgn,
        initiatedBy: "agent",
        stage: pick.requiresApproval ? "awaiting_approval" : "requested",
        paymentStatus: "not_started",
        createdAt: input.now,
      });
      continue;
    }

    // Nothing allowed. Work out why, and what we would buy if the constraint were lifted.
    const { reason, violations } = deferralFromCandidates(evaluated);
    // Recommendation for the owner. When money is the constraint, suggest the smallest
    // purchase that restores real service; otherwise, the right product for the need.
    const moneyBound = reason === "insufficient_budget" || reason === "insufficient_authority" || reason === "over_purchase_limit";
    const wouldBuy = moneyBound
      ? (evaluated.filter((c) => c.meetsMinimum).sort(byPrice)[0] ?? [...evaluated].sort(byCoverage)[0])
      : (evaluated.filter((c) => c.meetsPreferred).sort(byPrice)[0] ?? [...evaluated].sort(byCoverage)[0]);
    const competing = selected.length > 0 && (reason === "insufficient_budget" || reason === "insufficient_authority");
    defer(reason, {
      violations,
      recommendation: wouldBuy ? { product: wouldBuy.product, coverageHours: wouldBuy.coverageHours } : null,
      outrankedBy: competing ? selected[selected.length - 1]!.kind : null,
    });
  }

  const plannedNgn = selected.reduce((t, p) => t + p.product.amountNgn, 0);
  const after = summariseBudget(input.budget, input.policy, ledger);
  const outcome: DecisionOutcome = selected.some((p) => !p.requiresApproval)
    ? "purchase_started"
    : selected.length > 0
      ? "awaiting_approval"
      : flags.length > 0 && deferred.some((d) => d.reason === "unusual_usage")
        ? "flagged"
        : deferred.some((d) => d.reason !== "purchase_in_progress")
          ? "blocked"
          : flags.length > 0
            ? "flagged"
            : "no_action";

  return {
    now: input.now,
    assessments,
    candidates,
    selected,
    deferred,
    flags,
    outcome,
    budgetImpact: {
      remainingBeforeNgn: before.remainingNgn,
      plannedNgn,
      remainingAfterNgn: after.remainingNgn,
      agentAuthorityBeforeNgn: before.agentAuthorityRemainingNgn,
      agentAuthorityAfterNgn: after.agentAuthorityRemainingNgn,
    },
  };
}
