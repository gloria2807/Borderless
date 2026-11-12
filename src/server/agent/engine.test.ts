import { describe, expect, it } from "vitest";
import type { UtilityKind } from "../db/schema";
import { evaluateSpendingAuthority, type BudgetRules, type PolicyRules, type PurchaseLedgerEntry } from "../household/policy";
import { PROVIDER_MODULES } from "../providers/registry";
import type { Product } from "../providers/types";
import { forecast, type UsageSample } from "../usage/forecast";
import { decide, type DecisionInput, type UtilitySnapshot } from "./engine";
import { explain } from "./explain";

const NOW = new Date("2026-11-14T06:00:00Z");
const HOUR = 3_600_000;

const POLICY: PolicyRules = {
  autoPurchaseEnabled: true,
  perPurchaseLimitNgn: 5_000,
  overallAgentLimitNgn: 8_000,
  manualApprovalThresholdNgn: 4_000,
  approvedServices: ["electricity", "airtime", "data"],
  approvedNetworks: ["mtn"],
  approvedProviderIds: ["prv_demo_electricity", "prv_demo_airtime", "prv_demo_data"],
};
const BUDGET: BudgetRules = { amountNgn: 15_000, priorSpendNgn: 7_000, periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-12-01") };
const PRODUCTS = Object.fromEntries(Object.entries(PROVIDER_MODULES).map(([k, m]) => [k, m.listProducts()])) as Record<UtilityKind, Product[]>;

const BASE: Record<UtilityKind, { unit: "kWh" | "NGN" | "MB"; baseline: number }> = {
  electricity: { unit: "kWh", baseline: 0.32 },
  airtime: { unit: "NGN", baseline: 3 },
  data: { unit: "MB", baseline: 22 },
};

/** Steady hourly history at `rate` for the last `hours` hours. */
const history = (rate: number, hours = 6): UsageSample[] =>
  Array.from({ length: hours }, (_, i) => ({ simTime: new Date(NOW.getTime() - i * HOUR), delta: rate }));

function utility(
  kind: UtilityKind,
  balance: number,
  o: { rate?: number; expiresInHours?: number | null; available?: boolean; open?: boolean } = {},
): UtilitySnapshot {
  const b = BASE[kind];
  const expiresAt = kind === "data" && o.expiresInHours !== null ? new Date(NOW.getTime() + (o.expiresInHours ?? 24 * 20) * HOUR) : null;
  return {
    kind,
    accountId: `acc_${kind}`,
    providerId: `prv_demo_${kind}`,
    providerName: kind,
    providerAvailable: o.available ?? true,
    network: kind === "electricity" ? null : "mtn",
    forecast: forecast({ kind, balance, unit: b.unit, baselinePerHour: b.baseline, expiresAt }, history(o.rate ?? b.baseline), NOW),
    openPurchase: o.open ? { id: "pur_open", stage: "submitted", amountNgn: 1000 } : null,
  };
}

function input(utilities: UtilitySnapshot[], o: Partial<Omit<DecisionInput, "utilities">> = {}): DecisionInput {
  return { now: NOW, utilities, priorities: ["electricity", "data", "airtime"], policy: POLICY, budget: BUDGET, ledger: [], products: PRODUCTS, ...o };
}

const kinds = (xs: { kind: UtilityKind }[]) => xs.map((x) => x.kind);

describe("Example A — electricity nearly exhausted, data fine, airtime low but not urgent", () => {
  const d = decide(input([utility("electricity", 3), utility("data", 2_000), utility("airtime", 150)]));

  it("buys electricity only", () => {
    expect(kinds(d.selected)).toEqual(["electricity"]);
    expect(d.outcome).toBe("purchase_started");
  });
  it("assesses urgency correctly", () => {
    expect(d.assessments.find((a) => a.kind === "electricity")?.urgency).toBe("critical");
    expect(d.assessments.find((a) => a.kind === "airtime")?.urgency).toBe("watch");
    expect(d.assessments.find((a) => a.kind === "data")?.needsAction).toBe(false);
  });
  it("chooses a purchase that restores at least two days without needing approval", () => {
    const p = d.selected[0]!;
    expect(p.requiresApproval).toBe(false);
    expect(p.coverageHours).toBeGreaterThanOrEqual(48);
    expect(p.product.amountNgn).toBeLessThanOrEqual(POLICY.manualApprovalThresholdNgn);
  });
});

describe("budget sharing — two shortages, budget enough for both only if sized carefully", () => {
  const shared = { ...BUDGET, priorSpendNgn: 11_000 }; // ₦4,000 remaining
  const d = decide(input([utility("electricity", 8), utility("data", 600), utility("airtime", 900)], { budget: shared }));

  it("sizes the first purchase down so the second need is also covered", () => {
    expect(kinds(d.selected)).toEqual(["electricity", "data"]);
    expect(d.selected[0]).toMatchObject({ basis: "budget_shared", reservedFor: [{ kind: "data", amountNgn: 500 }] });
    for (const p of d.selected) expect(p.coverageHours).toBeGreaterThanOrEqual(48);
    expect(d.budgetImpact.plannedNgn).toBeLessThanOrEqual(4_000);
  });
  it("says why it bought less", () => {
    expect(explain(d).reasoning).toMatch(/buying less than I otherwise would so the budget also covers mobile data \(₦500\)/);
  });
});

describe("Example B — electricity and data both low, budget covers only one", () => {
  const tight = { ...BUDGET, priorSpendNgn: 13_000 }; // ₦2,000 remaining
  const d = decide(input([utility("electricity", 8), utility("data", 600), utility("airtime", 900)], { budget: tight }));

  it("buys the higher-priority need and defers the other", () => {
    expect(kinds(d.selected)).toEqual(["electricity"]);
    const deferred = d.deferred.find((x) => x.kind === "data");
    expect(deferred?.reason).toBe("insufficient_budget");
    expect(deferred?.outrankedBy).toBe("electricity");
  });
  it("never plans more than the remaining budget, and buys enough rather than the most", () => {
    expect(d.budgetImpact.plannedNgn).toBeLessThanOrEqual(2_000);
    expect(d.selected[0]!.coverageHours).toBeGreaterThanOrEqual(48);
  });
  it("explains the trade-off in plain language", () => {
    const text = explain(d).reasoning;
    expect(text).toMatch(/prioritising electricity over mobile data because it is higher in your priorities/);
    expect(text).toMatch(/deferred mobile data/);
  });
  it("follows the owner's priorities when they change", () => {
    const flipped = decide(input([utility("electricity", 8), utility("data", 600), utility("airtime", 900)], { budget: tight, priorities: ["data", "electricity", "airtime"] }));
    expect(kinds(flipped.selected)).toEqual(["data"]);
    expect(flipped.deferred.find((x) => x.kind === "electricity")).toMatchObject({ reason: "insufficient_budget", outrankedBy: "data" });
  });
  it("funds both generously when the budget allows", () => {
    const both = decide(input([utility("electricity", 8), utility("data", 600), utility("airtime", 900)]));
    expect(kinds(both.selected).sort()).toEqual(["data", "electricity"]);
    expect(both.selected.every((p) => p.basis !== "budget_shared")).toBe(true);
  });
  it("lets a critical need outrank a higher-priority but less urgent one", () => {
    const d2 = decide(input([utility("electricity", 8), utility("data", 100), utility("airtime", 900)], { budget: tight }));
    expect(d2.selected[0]?.kind).toBe("data"); // data critical (~5h) beats electricity low (~25h)
  });
});

describe("Example C — unusually high data consumption", () => {
  const d = decide(input([utility("electricity", 30), utility("data", 300, { rate: 60 }), utility("airtime", 900)]));

  it("flags the change and does not buy more data automatically", () => {
    expect(d.flags).toEqual([expect.objectContaining({ kind: "data", code: "unusual_usage" })]);
    expect(kinds(d.selected)).not.toContain("data");
    expect(d.deferred.find((x) => x.kind === "data")?.reason).toBe("unusual_usage");
    expect(d.outcome).toBe("flagged");
  });
  it("reports it as a change in household usage, never as a provider error", () => {
    const text = explain(d).reasoning.toLowerCase();
    expect(text).toMatch(/2\.7× this household's usual rate/);
    expect(text).toMatch(/review/);
    expect(text).not.toMatch(/wrong|deduct|overcharg|fraud|error/);
  });
  it("still handles other utilities normally", () => {
    const d2 = decide(input([utility("electricity", 3), utility("data", 300, { rate: 60 }), utility("airtime", 900)]));
    expect(kinds(d2.selected)).toEqual(["electricity"]);
  });
});

describe("Example D — budget insufficient for any eligible purchase", () => {
  const exhausted = { ...BUDGET, priorSpendNgn: 14_800 }; // ₦200 left
  const d = decide(input([utility("electricity", 2), utility("data", 2_000), utility("airtime", 900)], { budget: exhausted }));

  it("does not plan any payment", () => {
    expect(d.selected).toEqual([]);
    expect(d.outcome).toBe("blocked");
    expect(d.deferred[0]).toMatchObject({ kind: "electricity", reason: "insufficient_budget", outrankedBy: null });
  });
  it("explains the constraint and asks the owner to act", () => {
    const e = explain(d);
    expect(e.reasoning).toMatch(/Increase the budget or change priorities/);
    expect(e.reasoning).toMatch(/I'd recommend/);
    expect(e.headline).toMatch(/Can't buy electricity/);
  });
});

describe("spending authority edge cases", () => {
  it("agent disabled: recommends, but plans nothing", () => {
    const d = decide(input([utility("electricity", 2)], { policy: { ...POLICY, autoPurchaseEnabled: false } }));
    expect(d.selected).toEqual([]);
    expect(d.deferred[0]).toMatchObject({ reason: "agent_disabled" });
    expect(d.deferred[0]?.recommendation).not.toBeNull();
  });
  it("purchase above the per-transaction limit is never planned", () => {
    const d = decide(input([utility("electricity", 2)], { policy: { ...POLICY, perPurchaseLimitNgn: 500 } }));
    expect(d.selected).toEqual([]);
    expect(d.deferred[0]?.reason).toBe("over_purchase_limit");
  });
  it("routes a needed purchase above the approval threshold to the owner", () => {
    const d = decide(input([utility("electricity", 3)], { policy: { ...POLICY, manualApprovalThresholdNgn: 1_000 } }));
    expect(d.selected[0]).toMatchObject({ kind: "electricity", requiresApproval: true });
    expect(d.outcome).toBe("awaiting_approval");
  });
  it("buys partial relief for a critical shortage when limits allow nothing better", () => {
    const d = decide(input([utility("electricity", 1)], { policy: { ...POLICY, perPurchaseLimitNgn: 1_000, manualApprovalThresholdNgn: 1_000 } }));
    expect(d.selected[0]).toMatchObject({ basis: "partial_relief", partial: true });
  });
  it("respects the overall agent limit across multiple purchases in one run", () => {
    const d = decide(input([utility("electricity", 2), utility("data", 100)], { policy: { ...POLICY, overallAgentLimitNgn: 4_500 } }));
    expect(d.budgetImpact.plannedNgn).toBeLessThanOrEqual(4_500);
  });
  it("never plans a purchase the backend policy would deny (exhaustive budget sweep)", () => {
    for (let prior = 0; prior <= 15_000; prior += 250) {
      const budget = { ...BUDGET, priorSpendNgn: prior };
      const d = decide(input([utility("electricity", 2), utility("data", 100), utility("airtime", 20)], { budget }));
      const ledger: PurchaseLedgerEntry[] = [];
      for (const p of d.selected) {
        const r = evaluateSpendingAuthority(
          { kind: p.kind, providerId: `prv_demo_${p.kind}`, providerAvailable: true, network: p.kind === "electricity" ? null : "mtn", amountNgn: p.product.amountNgn, initiatedBy: "agent" },
          POLICY, budget, ledger, NOW,
        );
        expect(r.outcome).not.toBe("deny");
        ledger.push({ id: p.kind, amountNgn: p.product.amountNgn, initiatedBy: "agent", stage: "requested", paymentStatus: "not_started", createdAt: NOW });
      }
    }
  });
});

describe("other inputs", () => {
  it("does not start a second purchase while one is in progress", () => {
    const d = decide(input([utility("electricity", 2, { open: true })]));
    expect(d.selected).toEqual([]);
    expect(d.deferred[0]?.reason).toBe("purchase_in_progress");
    expect(d.outcome).toBe("no_action");
  });
  it("counts pending commitments against the budget", () => {
    const pending: PurchaseLedgerEntry[] = [{ id: "x", amountNgn: 7_500, initiatedBy: "owner", stage: "submitted", paymentStatus: "submitted", createdAt: NOW }];
    const d = decide(input([utility("electricity", 2)], { ledger: pending }));
    expect(d.selected).toEqual([]);
    expect(d.deferred[0]?.reason).toBe("insufficient_budget");
  });
  it("defers when the provider is unavailable", () => {
    const d = decide(input([utility("electricity", 2, { available: false })]));
    expect(d.deferred[0]?.reason).toBe("provider_unavailable");
  });
  it("treats an imminently expiring data bundle as a shortage", () => {
    const d = decide(input([utility("data", 5_000, { expiresInHours: 4 })]));
    expect(d.assessments[0]).toMatchObject({ kind: "data", urgency: "critical" });
    expect(d.assessments[0]?.forecast.limitedBy).toBe("expiry");
    expect(kinds(d.selected)).toEqual(["data"]);
  });
  it("reacts to usage changing between decisions", () => {
    const calm = decide(input([utility("electricity", 15)]));
    expect(calm.selected).toEqual([]); // 15 kWh at 0.32/h ≈ 47h — watch only
    const heavy = decide(input([utility("electricity", 15, { rate: 0.6 })]));
    expect(kinds(heavy.selected)).toEqual(["electricity"]); // same balance, ~25h at the new rate
  });
  it("does nothing when everything is comfortable", () => {
    const d = decide(input([utility("electricity", 60), utility("data", 4_000), utility("airtime", 1_000)]));
    expect(d.outcome).toBe("no_action");
    expect(explain(d).headline).toBe("Household is powered and connected");
  });
  it("is deterministic", () => {
    const i = input([utility("electricity", 8), utility("data", 600), utility("airtime", 150)]);
    expect(JSON.stringify(decide(i))).toBe(JSON.stringify(decide(i)));
  });
});

describe("explanation language", () => {
  it("separates facts, observations and predictions", () => {
    const e = explain(decide(input([utility("electricity", 3, { rate: 0.32 })])));
    const elec = e.lines.filter((l) => l.utility === "electricity");
    expect(elec.find((l) => l.kind === "fact")?.text).toBe("The meter reads 3 kWh.");
    expect(elec.find((l) => l.kind === "observation")?.text).toMatch(/last 6 hours averaged 0.3 kWh per hour/);
    expect(elec.find((l) => l.kind === "prediction")?.text).toMatch(/likely to run out in about 9 hours/);
    expect(elec.find((l) => l.kind === "decision")?.text).toMatch(/^Buying ₦/);
  });
});
