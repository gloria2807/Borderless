import { describe, expect, it } from "vitest";
import { evaluateSpendingAuthority, summariseBudget, type BudgetRules, type PolicyRules, type PurchaseIntent, type PurchaseLedgerEntry } from "./policy";

const policy: PolicyRules = {
  autoPurchaseEnabled: true,
  perPurchaseLimitNgn: 5_000,
  overallAgentLimitNgn: 8_000,
  manualApprovalThresholdNgn: 4_000,
  approvedServices: ["electricity", "airtime", "data"],
  approvedNetworks: ["mtn"],
  approvedProviderIds: ["prv_e", "prv_a"],
};
const budget: BudgetRules = { amountNgn: 15_000, priorSpendNgn: 7_000, periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-12-01") };
const now = new Date("2026-11-14T06:00:00Z");
const intent = (o: Partial<PurchaseIntent> = {}): PurchaseIntent => ({
  kind: "electricity", providerId: "prv_e", providerAvailable: true, network: null, amountNgn: 3_000, initiatedBy: "agent", ...o,
});
let n = 0;
const entry = (o: Partial<PurchaseLedgerEntry>): PurchaseLedgerEntry => ({
  id: `p${n++}`, amountNgn: 1_000, initiatedBy: "agent", stage: "completed", paymentStatus: "confirmed", createdAt: now, ...o,
});
const codes = (r: ReturnType<typeof evaluateSpendingAuthority>) => r.violations.map((v) => v.code);

describe("spending authority", () => {
  it("allows an in-limit purchase", () => {
    expect(evaluateSpendingAuthority(intent(), policy, budget, [], now).outcome).toBe("allow");
  });

  it("denies when automatic purchasing is disabled (agent cannot act)", () => {
    const r = evaluateSpendingAuthority(intent(), { ...policy, autoPurchaseEnabled: false }, budget, [], now);
    expect(r.outcome).toBe("deny");
    expect(codes(r)).toContain("agent_disabled");
  });

  it("denies above the per-purchase limit", () => {
    expect(codes(evaluateSpendingAuthority(intent({ amountNgn: 5_500 }), policy, budget, [], now))).toContain("exceeds_per_purchase_limit");
  });

  it("denies when the remaining budget is insufficient, counting pending commitments", () => {
    const ledger = [entry({ amountNgn: 3_000 }), entry({ amountNgn: 2_500, stage: "submitted", paymentStatus: "submitted" })];
    // 15,000 − 7,000 prior − 3,000 paid − 2,500 committed = 2,500 left
    const r = evaluateSpendingAuthority(intent({ amountNgn: 3_000 }), policy, budget, ledger, now);
    expect(r.summary.remainingNgn).toBe(2_500);
    expect(codes(r)).toContain("exceeds_budget");
  });

  it("does not count failed or cancelled purchases against the budget", () => {
    const ledger = [entry({ amountNgn: 5_000, stage: "failed", paymentStatus: "failed" }), entry({ amountNgn: 5_000, stage: "cancelled", paymentStatus: "not_started" })];
    expect(summariseBudget(budget, policy, ledger).remainingNgn).toBe(8_000);
  });

  it("treats an unknown payment outcome as committed (never double-spends)", () => {
    const ledger = [entry({ amountNgn: 4_000, stage: "needs_attention", paymentStatus: "unknown" })];
    expect(summariseBudget(budget, policy, ledger).committedNgn).toBe(4_000);
  });

  it("enforces the overall agent limit separately from the household budget", () => {
    const bigBudget = { ...budget, amountNgn: 100_000 };
    const ledger = [entry({ amountNgn: 4_000 }), entry({ amountNgn: 3_000 })];
    const r = evaluateSpendingAuthority(intent({ amountNgn: 1_500 }), policy, bigBudget, ledger, now);
    expect(codes(r)).toEqual(["exceeds_agent_authority"]);
  });

  it("owner purchases do not consume agent authority", () => {
    const bigBudget = { ...budget, amountNgn: 100_000 };
    const ledger = [entry({ amountNgn: 4_000, initiatedBy: "owner" }), entry({ amountNgn: 3_000, initiatedBy: "owner" })];
    expect(evaluateSpendingAuthority(intent({ amountNgn: 1_500 }), policy, bigBudget, ledger, now).outcome).toBe("allow");
  });

  it("requires owner approval above the threshold, and accepts it once approved", () => {
    expect(evaluateSpendingAuthority(intent({ amountNgn: 4_500 }), policy, budget, [], now).outcome).toBe("require_approval");
    expect(evaluateSpendingAuthority(intent({ amountNgn: 4_500, ownerApproved: true }), policy, budget, [], now).outcome).toBe("allow");
  });

  it("approval never overrides hard limits", () => {
    const r = evaluateSpendingAuthority(intent({ amountNgn: 6_000, ownerApproved: true }), policy, budget, [], now);
    expect(r.outcome).toBe("deny");
  });

  it("denies unapproved services, providers and networks", () => {
    expect(codes(evaluateSpendingAuthority(intent({ kind: "data", providerId: "prv_d", network: "mtn" }), { ...policy, approvedServices: ["electricity"] }, budget, [], now)))
      .toEqual(expect.arrayContaining(["service_not_approved", "provider_not_approved"]));
    expect(codes(evaluateSpendingAuthority(intent({ kind: "airtime", providerId: "prv_a", network: "glo" }), policy, budget, [], now))).toContain("network_not_approved");
  });

  it("denies when the provider is unavailable or no budget period is active", () => {
    expect(codes(evaluateSpendingAuthority(intent({ providerAvailable: false }), policy, budget, [], now))).toContain("provider_unavailable");
    expect(codes(evaluateSpendingAuthority(intent(), policy, budget, [], new Date("2026-12-02")))).toContain("budget_period_inactive");
  });

  it("excludes the purchase being executed from its own commitment", () => {
    const ledger = [entry({ id: "self", amountNgn: 3_000, stage: "requested", paymentStatus: "not_started" })];
    expect(evaluateSpendingAuthority(intent(), policy, { ...budget, priorSpendNgn: 12_000 }, ledger, now, "self").outcome).toBe("allow");
  });
});
