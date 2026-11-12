/**
 * Demo scenarios. ALL VALUES ARE ILLUSTRATIVE DEMO DATA — not a real household.
 *
 * Each scenario is a deterministic starting state. The outcome is NOT scripted:
 * the agent's real decision engine, budget rules and payment flow produce it.
 * The `expect` text only tells the operator what to look for.
 */
import type { UtilityKind } from "../db/schema";

export interface UtilitySeed {
  balance: number;
  /** Usual consumption per hour (the household's baseline). */
  perHour: number;
  /** Simulator speed applied going forward. */
  multiplier?: number;
  /** Recent observed rate for the last `recentHours` of history (defaults to perHour). */
  recentPerHour?: number;
  recentHours?: number;
  /** Data only: hours until the active bundle expires. */
  expiresInHours?: number;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  /** One sentence for the picker. */
  summary: string;
  /** What the operator should watch for. */
  expect: string;
  budget: { amountNgn: number; priorSpendNgn: number };
  policy?: Partial<{
    autoPurchaseEnabled: boolean;
    perPurchaseLimitNgn: number;
    overallAgentLimitNgn: number;
    manualApprovalThresholdNgn: number;
  }>;
  utilities: Record<UtilityKind, UtilitySeed>;
}

const BASE_UTILITIES: Record<UtilityKind, UtilitySeed> = {
  electricity: { balance: 8, perHour: 0.32 },
  airtime: { balance: 200, perHour: 3 },
  data: { balance: 150, perHour: 22, expiresInHours: 9 * 24 },
};

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: "both-low",
    name: "Electricity and data both running low",
    summary: "₦8,000 left of ₦15,000. About a day of electricity and six hours of data.",
    expect: "Borderless ranks data first (more urgent), buys both within budget and explains why.",
    budget: { amountNgn: 15_000, priorSpendNgn: 7_000 },
    utilities: BASE_UTILITIES,
  },
  {
    id: "budget-covers-one",
    name: "Budget covers only one",
    summary: "₦2,000 left. Electricity and data both low, about a day each.",
    expect: "Borderless buys electricity (your top priority) and defers data, saying why.",
    budget: { amountNgn: 15_000, priorSpendNgn: 13_000 },
    utilities: { ...BASE_UTILITIES, data: { balance: 600, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "unusual-data",
    name: "Unusual data usage",
    summary: "Data has been draining at three times the usual rate for six hours.",
    expect: "Borderless flags the change for review instead of buying more data.",
    budget: { amountNgn: 15_000, priorSpendNgn: 4_000 },
    utilities: {
      electricity: { balance: 40, perHour: 0.32 },
      airtime: { balance: 900, perHour: 3 },
      data: { balance: 400, perHour: 22, multiplier: 3, recentPerHour: 66, recentHours: 6, expiresInHours: 12 * 24 },
    },
  },
  {
    id: "budget-exhausted",
    name: "Budget exhausted",
    summary: "₦200 left this month and electricity is nearly out.",
    expect: "Borderless does not attempt payment and asks you to raise the budget or change priorities.",
    budget: { amountNgn: 15_000, priorSpendNgn: 14_800 },
    utilities: { ...BASE_UTILITIES, electricity: { balance: 2, perHour: 0.32 }, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "needs-approval",
    name: "Purchase needs approval",
    summary: "Your approval threshold is ₦1,000 and electricity is nearly out.",
    expect: "Borderless parks the purchase and waits for you to approve or decline it.",
    budget: { amountNgn: 15_000, priorSpendNgn: 5_000 },
    policy: { manualApprovalThresholdNgn: 1_000 },
    utilities: { ...BASE_UTILITIES, electricity: { balance: 3, perHour: 0.32 }, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "authority-revoked",
    name: "Authority revoked",
    summary: "Automatic purchasing is off while electricity runs low.",
    expect: "Borderless keeps monitoring and recommends a purchase, but spends nothing.",
    budget: { amountNgn: 15_000, priorSpendNgn: 7_000 },
    policy: { autoPurchaseEnabled: false },
    utilities: { ...BASE_UTILITIES, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
];

export const DEFAULT_SCENARIO_ID = "both-low";

export function scenarioById(id: string | undefined): ScenarioDefinition {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS.find((s) => s.id === DEFAULT_SCENARIO_ID)!;
}
