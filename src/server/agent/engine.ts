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
import { URGENCY_HOURS, type Forecast, type UrgencyLevel } from "../usage/forecast";

const URGENCY_THRESHOLD_LOW = URGENCY_HOURS.low;

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
  /** Every provider that can serve this account, with live availability. */
  providers?: Record<string, { name: string; available: boolean }>;
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
  /** Paid information services that could explain a utility's usage (e.g. meter diagnostics). */
  informationOffers?: Partial<Record<UtilityKind, InformationOffer[]>>;
  /** The latest paid diagnosis per utility, if one was bought recently. */
  diagnoses?: Partial<Record<UtilityKind, Diagnosis>>;
}

export interface InformationOffer {
  providerId: string;
  name: string;
  priceNgn: number;
  available: boolean;
  detail: "basic" | "detailed";
}

/** What a paid diagnostic found (from its report; provider data). */
export interface Diagnosis {
  purchaseId: string;
  providerId: string;
  finding: "stuck_load" | "extra_occupancy" | "meter_overreading" | "normal" | "insufficient_data";
  summary: string;
  ownerAction: string | null;
  expectedNormalPerHour: number;
  observedPerHour: number;
}

/** Whether buying information is worth it for a utility, and why. */
export interface InformationDecision {
  kind: UtilityKind;
  action: "buy" | "not_worth_it" | "diagnosed";
  /** Machine-readable reason. */
  code: "unexplained_usage" | "not_urgent" | "too_expensive" | "outside_limits" | "no_offer" | "genuine_use" | "avoidable_use" | "inconclusive";
  reason: string;
  providerId?: string;
  providerName?: string;
  priceNgn?: number;
  /** The purchase the information could change (what we'd otherwise buy). */
  stakeNgn?: number;
  /** Other offers, and why they were not chosen. */
  alternatives?: { providerId: string; name: string; priceNgn: number; why: string }[];
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
  basis: "preferred" | "best_within_limits" | "partial_relief" | "budget_shared" | "diagnosed_minimum";
  /** Budget deliberately left for these later needs when sizing this purchase. */
  reservedFor: { kind: UtilityKind; amountNgn: number }[];
}

export type DeferralReason =
  | "awaiting_diagnosis"
  | "diagnosed_avoidable"
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

export type DecisionOutcome = "no_action" | "purchase_started" | "buying_information" | "awaiting_approval" | "blocked" | "flagged";

export interface BudgetImpact {
  remainingBeforeNgn: number;
  plannedNgn: number;
  remainingAfterNgn: number;
  agentAuthorityBeforeNgn: number;
  agentAuthorityAfterNgn: number;
}

/** One purchase option the engine weighed, and what happened to it. */
export interface OptionView {
  providerId: string;
  productCode: string;
  label: string;
  amountNgn: number;
  coverageHours: number | null;
  /** NGN per day of service, when it can be computed. */
  ngnPerDay: number | null;
  status: "chosen" | "rejected" | "recommended";
  /** Why it was not chosen (empty for the chosen option). */
  reason: string | null;
}

/** Every option considered for one utility, with the expected effect of the choice. */
export interface UtilityOptions {
  kind: UtilityKind;
  considered: OptionView[];
  /** Expected household impact of the chosen option (null if nothing was chosen). */
  impact: { balanceBefore: number; balanceAfter: number; unit: string; hoursBefore: number | null; hoursAfter: number | null; costNgn: number } | null;
}

/** A utility that needs no purchase now, and why. */
export interface NotNeeded {
  kind: UtilityKind;
  hoursRemaining: number | null;
  reason: string;
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
  /** Alternatives considered and rejected, per utility that needed action. */
  options: UtilityOptions[];
  /** Utilities that were checked and need nothing now. */
  notNeeded: NotNeeded[];
  /** Whether to buy information before deciding a utility, per utility with unexplained use. */
  information: InformationDecision[];
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
    const providerId = product.providerId ?? u.providerId;
    const providerAvailable = u.providers?.[providerId]?.available ?? (providerId === u.providerId && u.providerAvailable);
    const authority = evaluateSpendingAuthority(
      {
        kind: u.kind,
        providerId,
        providerAvailable,
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

// Equal prices (e.g. two providers selling ₦2,000 of power): prefer the one that delivers more.
const byPrice = (a: Candidate, b: Candidate) => a.product.amountNgn - b.product.amountNgn || b.coverageHours - a.coverageHours;
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
  exceeds_task_budget: "insufficient_authority",
  exceeds_daily_budget: "insufficient_authority",
  exceeds_reserve: "insufficient_budget",
  exceeds_per_purchase_limit: "over_purchase_limit",
  exceeds_utility_limit: "over_purchase_limit",
  recipient_not_permitted: "network_not_approved",
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

/**
 * A diagnostic is worth buying only if it could change a purchase that matters: its price
 * must be a small share of the purchase it could change. Documented, deliberate tunable.
 */
export const VALUE_OF_INFORMATION_SHARE = 0.2;

const AVOIDABLE: Diagnosis["finding"][] = ["stuck_load", "meter_overreading"];

function decideInformation(u: UtilitySnapshot, stakeNgn: number, input: DecisionInput, ledger: PurchaseLedgerEntry[]): InformationDecision {
  const offers = [...(input.informationOffers?.[u.kind] ?? [])].sort((a, b) => a.priceNgn - b.priceNgn);
  const ratio = u.forecast.usageRatio.toFixed(1);
  if (!offers.length) return { kind: u.kind, action: "not_worth_it", code: "no_offer", reason: `No information service can explain the ${ratio}× ${u.kind} use, so I can't check it before buying.`, stakeNgn };
  const maxPrice = Math.floor(stakeNgn * VALUE_OF_INFORMATION_SHARE);
  const judged = offers.map((o) => {
    const authority = evaluateSpendingAuthority(
      { kind: u.kind, providerId: o.providerId, providerAvailable: o.available, network: u.network, amountNgn: o.priceNgn, initiatedBy: "agent", serviceType: "meter_diagnostic" },
      input.policy,
      input.budget,
      ledger,
      input.now,
    );
    const why =
      authority.outcome === "deny"
        ? (authority.violations[0]?.message ?? "Refused by your spending rules.")
        : authority.outcome === "require_approval"
          ? "Would need your approval."
          : o.priceNgn > maxPrice
            ? `Costs ${ngn(o.priceNgn)}, more than ${Math.round(VALUE_OF_INFORMATION_SHARE * 100)}% of the ${ngn(stakeNgn)} purchase it could change.`
            : null;
    return { o, why, authority: authority.outcome };
  });
  const chosen = judged.find((j) => j.why === null);
  if (!chosen) {
    const priceBlocked = judged.every((j) => j.authority === "allow" && j.why?.startsWith("Costs"));
    return {
      kind: u.kind,
      action: "not_worth_it",
      code: priceBlocked ? "too_expensive" : "outside_limits",
      reason: priceBlocked
        ? `A diagnostic would cost more than it could save: the cheapest is ${ngn(offers[0]!.priceNgn)} against a ${ngn(stakeNgn)} purchase.`
        : `Your rules don't allow buying a diagnostic now (${judged[0]!.why})`,
      stakeNgn,
      alternatives: judged.map((j) => ({ providerId: j.o.providerId, name: j.o.name, priceNgn: j.o.priceNgn, why: j.why ?? "" })),
    };
  }
  return {
    kind: u.kind,
    action: "buy",
    code: "unexplained_usage",
    reason: `${u.kind[0]!.toUpperCase() + u.kind.slice(1)} use is ${ratio}× usual and hourly totals can't say why. A ${ngn(chosen.o.priceNgn)} diagnostic could change a ${ngn(stakeNgn)} purchase, so it is worth checking first.`,
    providerId: chosen.o.providerId,
    providerName: chosen.o.name,
    priceNgn: chosen.o.priceNgn,
    stakeNgn,
    alternatives: judged
      .filter((j) => j !== chosen)
      .map((j) => ({ providerId: j.o.providerId, name: j.o.name, priceNgn: j.o.priceNgn, why: j.why ?? (j.o.priceNgn > chosen.o.priceNgn ? `Costs ${ngn(j.o.priceNgn - chosen.o.priceNgn)} more; its extra detail would not change the purchase.` : "Not chosen.") })),
  };
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
  const information: InformationDecision[] = [];
  const diagnosisOf = (kind: UtilityKind) => input.diagnoses?.[kind];
  /** Usage the agent can't explain yet: unusual, and no diagnosis bought. */
  const unexplained = (u: UtilitySnapshot) => u.forecast.unusualUsage && !diagnosisOf(u.kind);
  /** A diagnosis found the extra use avoidable (stuck load, faulty meter). */
  const avoidable = (u: UtilitySnapshot) => u.forecast.unusualUsage && AVOIDABLE.includes(diagnosisOf(u.kind)?.finding ?? "normal");
  const blocked = (u: UtilitySnapshot) => unexplained(u) || avoidable(u);

  // Needs the agent may actually buy for, in decision order (used for budget sharing).
  const actionable = assessments.filter((a) => {
    const u = input.utilities.find((x) => x.kind === a.kind)!;
    return a.needsAction && !u.openPurchase && !blocked(u);
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
    const diagnosis = diagnosisOf(u.kind);
    if (u.forecast.unusualUsage && diagnosis) {
      const genuine = !AVOIDABLE.includes(diagnosis.finding);
      information.push({
        kind: u.kind,
        action: "diagnosed",
        code: diagnosis.finding === "insufficient_data" ? "inconclusive" : genuine ? "genuine_use" : "avoidable_use",
        reason: diagnosis.summary,
        providerId: diagnosis.providerId,
      });
    }
    if (!a.needsAction) {
      if (unexplained(u)) {
        information.push({
          kind: u.kind,
          action: "not_worth_it",
          code: "not_urgent",
          reason: `${u.kind[0]!.toUpperCase() + u.kind.slice(1)} use is ${u.forecast.usageRatio.toFixed(1)}× usual, but there is enough left that no purchase depends on the cause yet. I'll keep watching and check it if it becomes urgent.`,
        });
      }
      continue;
    }

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
    if (pick && !pick.requiresApproval && !blocked(u)) {
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

    // Unusual consumption with no explanation: is a diagnostic worth buying first?
    if (unexplained(u)) {
      // The stake is the purchase the information could change: what we could actually buy now.
      const info: InformationDecision = pick
        ? decideInformation(u, pick.product.amountNgn, input, ledger)
        : {
            kind: u.kind,
            action: "not_worth_it",
            code: "outside_limits",
            reason: `No ${u.kind} purchase is possible within your limits right now, so a diagnostic could not change what I buy.`,
            stakeNgn: 0,
          };
      information.push(info);
      const recommendation = pick ? { product: pick.product, coverageHours: pick.coverageHours } : null;
      if (info.action === "buy") {
        ledger.push({ id: `planned:info:${u.kind}`, amountNgn: info.priceNgn!, initiatedBy: "agent", stage: "requested", paymentStatus: "not_started", createdAt: input.now });
        defer("awaiting_diagnosis", { recommendation });
      } else {
        // Not worth checking: don't buy more automatically — ask the owner to review.
        defer("unusual_usage", { recommendation });
      }
      continue;
    }

    // A diagnosis says the extra use is avoidable: buy only minimal relief if the meter would
    // otherwise run out soon (sized at the NORMAL rate), and tell the owner what to fix.
    if (avoidable(u) && diagnosis) {
      const atNormal: UtilitySnapshot = { ...u, forecast: { ...u.forecast, ratePerHour: diagnosis.expectedNormalPerHour, unusualUsage: false } };
      // Judge every option on the same basis as the choice: service at the normal rate.
      const atNormalCandidates = evaluateCandidates(atNormal, input, ledger);
      for (let i = candidates.length - 1; i >= 0; i -= 1) if (candidates[i]!.kind === u.kind) candidates.splice(i, 1);
      candidates.push(...atNormalCandidates);
      const relief = a.urgency === "critical"
        ? atNormalCandidates.filter((c) => c.authority === "allow" && c.meetsMinimum).sort(byPrice)[0]
        : undefined;
      if (relief) {
        const plan: PlannedPurchase = { kind: u.kind, product: relief.product, coverageHours: relief.coverageHours, requiresApproval: false, partial: false, basis: "diagnosed_minimum", reservedFor: [] };
        selected.push(plan);
        ledger.push({ id: `planned:${u.kind}`, amountNgn: plan.product.amountNgn, initiatedBy: "agent", stage: "requested", paymentStatus: "not_started", createdAt: input.now });
      } else {
        defer("diagnosed_avoidable", { recommendation: pick ? { product: pick.product, coverageHours: pick.coverageHours } : null });
      }
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
    : information.some((i) => i.action === "buy")
      ? "buying_information"
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
    options: buildOptions(input, candidates, selected, deferred),
    information,
    notNeeded: assessments.filter((a) => !a.needsAction).map((a) => notNeededFor(a)),
    budgetImpact: {
      remainingBeforeNgn: before.remainingNgn,
      plannedNgn,
      remainingAfterNgn: after.remainingNgn,
      agentAuthorityBeforeNgn: before.agentAuthorityRemainingNgn,
      agentAuthorityAfterNgn: after.agentAuthorityRemainingNgn,
    },
  };
}

// ── Options considered (audit and explanation) ─────────────────────────────

const ngn = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const span = (hours: number) => (!Number.isFinite(hours) ? "indefinitely" : hours >= 48 ? `about ${Math.round(hours / 24)} days` : `about ${Math.round(hours)} hours`);
const finite = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/** Why `c` lost to `chosen` (or why nothing could be bought). Deterministic, evidence-based. */
export function rejectionReason(c: Candidate, chosen: PlannedPurchase | null): string {
  if (c.authority === "deny") return c.violations[0]?.message ?? "Refused by the household's spending rules.";
  if (!chosen) return c.authority === "require_approval" ? "Would need your approval." : "Not chosen.";
  if (c.authority === "require_approval" && !chosen.requiresApproval) return "Would need your approval; an option within your limits was available.";
  if (!c.meetsMinimum) return `Restores only ${span(c.coverageHours)} of service — less than the 2-day minimum.`;
  const extra = c.product.amountNgn - chosen.product.amountNgn;
  if (extra > 0) {
    if (chosen.basis === "budget_shared") return `Costs ${ngn(extra)} more and would leave too little budget for ${chosen.reservedFor.map((r) => r.kind).join(" and ")}.`;
    if (chosen.basis === "preferred") return `Costs ${ngn(extra)} more than needed; the chosen option already restores the target coverage.`;
    return `Costs ${ngn(extra)} more than the chosen option.`;
  }
  if (extra === 0) return c.coverageHours < chosen.coverageHours ? "Same price, less service." : "Same price and service; the chosen offer was listed first.";
  if (chosen.basis === "preferred" && !c.meetsPreferred) return `Cheaper, but restores only ${span(c.coverageHours)} — short of the target.`;
  return `Cheaper, but gives less service: about ${Math.round(c.coverageHours)} hours vs ${Math.round(chosen.coverageHours)}.`;
}

function buildOptions(input: DecisionInput, candidates: Candidate[], selected: PlannedPurchase[], deferred: Deferral[]): UtilityOptions[] {
  const kinds = [...new Set(candidates.map((c) => c.kind))];
  return kinds.map((kind) => {
    const chosen = selected.find((p) => p.kind === kind) ?? null;
    const recommendation = deferred.find((d) => d.kind === kind)?.recommendation ?? null;
    const isChosen = (c: Candidate) => !!chosen && c.product.providerId === chosen.product.providerId && c.product.code === chosen.product.code;
    const isRecommended = (c: Candidate) => !!recommendation && c.product.providerId === recommendation.product.providerId && c.product.code === recommendation.product.code;
    const considered = candidates
      .filter((c) => c.kind === kind)
      .map((c): OptionView => {
        const cover = finite(c.coverageHours);
        return {
          providerId: c.product.providerId,
          productCode: c.product.code,
          label: c.product.label,
          amountNgn: c.product.amountNgn,
          coverageHours: cover,
          ngnPerDay: cover && cover > 0 ? Math.round((c.product.amountNgn / cover) * 24) : null,
          status: isChosen(c) ? "chosen" : isRecommended(c) ? "recommended" : "rejected",
          reason: isChosen(c) ? null : rejectionReason(c, chosen),
        };
      })
      .sort((a, b) => (a.status === "chosen" ? -1 : b.status === "chosen" ? 1 : a.amountNgn - b.amountNgn || (b.coverageHours ?? 0) - (a.coverageHours ?? 0)));
    const u = input.utilities.find((x) => x.kind === kind)!;
    const impact = chosen
      ? {
          balanceBefore: u.forecast.balance,
          balanceAfter: Math.round((Math.max(0, u.forecast.balance) + chosen.product.quantity) * 100) / 100,
          unit: u.forecast.unit,
          hoursBefore: finite(u.forecast.hoursRemaining),
          hoursAfter: finite(chosen.coverageHours),
          costNgn: chosen.product.amountNgn,
        }
      : null;
    return { kind, considered, impact };
  });
}

function notNeededFor(a: Assessment): NotNeeded {
  const h = a.forecast.hoursRemaining;
  const reason = !Number.isFinite(h)
    ? "No consumption recorded; nothing to top up."
    : a.urgency === "watch"
      ? `${span(h)} of service left. Borderless buys when less than ${URGENCY_THRESHOLD_LOW} hours remain, and keeps watching.`
      : `${span(h)} of service left — comfortably above the ${URGENCY_THRESHOLD_LOW}-hour buying point.`;
  return { kind: a.kind, hoursRemaining: finite(h), reason };
}
