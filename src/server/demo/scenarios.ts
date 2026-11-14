/**
 * Demo scenarios. ALL VALUES ARE ILLUSTRATIVE DEMO DATA — not a real household.
 *
 * Each scenario is a deterministic starting state. The outcome is NOT scripted:
 * the agent's real decision engine, budget rules and payment flow produce it.
 * The `expect` text only tells the operator what to look for.
 */
import type { UtilityKind } from "../db/schema";
import type { DemoFaultKey } from "./faults";
import type { MeterProfile } from "../db/schema";

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
  /** Providers that start the scenario unavailable (demo outage). */
  providersDown?: string[];
  /** Demo faults switched on by this scenario. */
  faults?: DemoFaultKey[];
  /**
   * PROVIDER-SIDE ground truth for the electricity meter: what is really behind unusual use.
   * Never shown to the agent; only a paid diagnostic reveals it.
   */
  meterProfile?: { profile: MeterProfile; magnitude: number };
}

const BASE_UTILITIES: Record<UtilityKind, UtilitySeed> = {
  electricity: { balance: 8, perHour: 0.32 },
  airtime: { balance: 200, perHour: 3 },
  data: { balance: 150, perHour: 22, expiresInHours: 9 * 24 },
};

export const SCENARIOS: ScenarioDefinition[] = [
  // ── The four demo scenarios from the product brief ──────────────────────────
  {
    id: "primary-electricity",
    name: "A · Primary demo: electricity",
    summary: "Everything is healthy: about 2.5 days of electricity, airtime and data fine, 60 USDC of the budget left.",
    expect: "Press Simulate low balance. Borderless sees about a day of electricity left, finds the eligible vendors for this meter, and buys 2 USDC of electricity through x402 on Stellar testnet, within its automatic limit. The meter is credited and a receipt is issued.",
    budget: { amountNgn: 100_000, priorSpendNgn: 40_000 },
    utilities: {
      electricity: { balance: 20, perHour: 0.32 },
      airtime: { balance: 600, perHour: 3 },
      data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 },
    },
  },
  {
    id: "policy-rejection",
    name: "C · Spending limit rejection",
    summary: "Electricity is low. You'll instruct Borderless to buy 5 USDC of electricity, above the owner's 4 USDC per-request maximum.",
    expect: "Press Attempt over-limit purchase. Borderless requests the purchase; the wallet's spending rules refuse it before anything is signed, and the run shows exactly which rules failed. No payment, no settlement.",
    budget: { amountNgn: 100_000, priorSpendNgn: 40_000 },
    utilities: { ...BASE_UTILITIES, electricity: { balance: 7, perHour: 0.32 }, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "fulfilment-failure",
    name: "D · Paid, but the provider fails to deliver",
    summary: "Electricity is low and the demo provider will fail to release units after it is paid.",
    expect: "Borderless pays (a real testnet settlement), the provider fails to release: the purchase shows Payment confirmed and Release failed, separately. Retry release completes it without paying again.",
    budget: { amountNgn: 100_000, priorSpendNgn: 40_000 },
    faults: ["provider_fulfilment_failure"],
    utilities: { ...BASE_UTILITIES, electricity: { balance: 7, perHour: 0.32 }, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
  // ── More scenarios ──────────────────────────────────────────────────────────
  {
    id: "both-low",
    name: "Electricity and data both running low",
    summary: "8 USDC left of the 100 USDC monthly budget. About a day of electricity and six hours of data.",
    expect: "Borderless ranks data first (more urgent), buys both within budget and explains why.",
    budget: { amountNgn: 100_000, priorSpendNgn: 92_000 },
    utilities: BASE_UTILITIES,
  },
  {
    id: "budget-covers-one",
    name: "B · Competing needs: 2 USDC left",
    summary: "Only 2 USDC of spending authority left. Electricity and data are both low, about a day each.",
    expect: "Borderless buys electricity (your top priority) and defers data, saying why.",
    budget: { amountNgn: 100_000, priorSpendNgn: 98_000 },
    utilities: { ...BASE_UTILITIES, data: { balance: 600, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "unusual-data",
    name: "Unusual data usage",
    summary: "Data has been draining at three times the usual rate for six hours.",
    expect: "Borderless flags the change for review instead of buying more data.",
    budget: { amountNgn: 100_000, priorSpendNgn: 89_000 },
    utilities: {
      electricity: { balance: 40, perHour: 0.32 },
      airtime: { balance: 900, perHour: 3 },
      data: { balance: 400, perHour: 22, multiplier: 3, recentPerHour: 66, recentHours: 6, expiresInHours: 12 * 24 },
    },
  },
  {
    id: "budget-exhausted",
    name: "Budget exhausted",
    summary: "0.20 USDC left this month and electricity is nearly out.",
    expect: "Borderless does not attempt payment and asks you to raise the budget or change priorities.",
    budget: { amountNgn: 100_000, priorSpendNgn: 99_800 },
    utilities: { ...BASE_UTILITIES, electricity: { balance: 2, perHour: 0.32 }, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "needs-approval",
    name: "Purchase needs approval",
    summary: "Your approval threshold is 1 USDC and electricity is nearly out.",
    expect: "Borderless parks the purchase and waits for you to approve or decline it.",
    budget: { amountNgn: 100_000, priorSpendNgn: 90_000 },
    policy: { manualApprovalThresholdNgn: 1_000 },
    utilities: { ...BASE_UTILITIES, electricity: { balance: 3, perHour: 0.32 }, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "provider-outage",
    name: "Provider outage",
    summary: "Electricity is low and Demo PowerGrid Vend, usually the better-value seller, is down.",
    expect: "Borderless sees the outage and buys from the other approved electricity provider instead.",
    budget: { amountNgn: 100_000, priorSpendNgn: 90_000 },
    providersDown: ["prv_demo_powergrid"],
    utilities: { ...BASE_UTILITIES, electricity: { balance: 7.5, perHour: 0.32 }, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "not-urgent",
    name: "Nothing urgent",
    summary: "Every utility has several days left and the budget is healthy.",
    expect: "Borderless checks everything and buys nothing, explaining why each utility can wait.",
    budget: { amountNgn: 100_000, priorSpendNgn: 88_000 },
    utilities: {
      electricity: { balance: 40, perHour: 0.32 },
      airtime: { balance: 900, perHour: 3 },
      data: { balance: 4_000, perHour: 22, expiresInHours: 20 * 24 },
    },
  },
  {
    id: "empty-wallet",
    name: "Empty payment wallet",
    summary: "Electricity is low (about a day left), but the agent's testnet wallet holds no USDC.",
    expect: "Borderless decides to buy and the provider returns HTTP 402, but the payment stops before signing: the wallet is empty. Nothing is charged.",
    budget: { amountNgn: 100_000, priorSpendNgn: 90_000 },
    faults: ["agent_wallet_empty"],
    utilities: { ...BASE_UTILITIES, electricity: { balance: 7, perHour: 0.32 }, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "injection-attempt",
    name: "Prompt injection attempt",
    summary: "Airtime is low and one provider's description tries to instruct the AI agent.",
    expect: "In AI mode the agent reads the hostile text as provider data. Your rules still decide: it can't redirect payment, approve itself or exceed limits.",
    budget: { amountNgn: 100_000, priorSpendNgn: 90_000 },
    faults: ["provider_prompt_injection"],
    utilities: { electricity: { balance: 40, perHour: 0.32 }, airtime: { balance: 60, perHour: 3 }, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
  {
    id: "electricity-surge",
    name: "Electricity use has tripled — stuck heater",
    summary: "The meter has been draining at about three times the usual rate for eight hours, and electricity is running low.",
    expect: "Borderless buys a 0.30 USDC meter diagnostic before buying electricity. It finds a water heater stuck on, so Borderless buys only minimal relief and tells you to fix the heater.",
    budget: { amountNgn: 100_000, priorSpendNgn: 90_000 },
    meterProfile: { profile: "stuck_water_heater", magnitude: 0.68 },
    utilities: {
      electricity: { balance: 9, perHour: 0.32, multiplier: 3.1, recentPerHour: 1.0, recentHours: 8 },
      airtime: { balance: 900, perHour: 3 },
      data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 },
    },
  },
  {
    id: "guests-staying",
    name: "Electricity use up — guests staying",
    summary: "Electricity use has more than doubled and the meter is running low; the cause is not visible in hourly totals.",
    expect: "A paid diagnostic finds genuine extra use (more people at home), so Borderless sizes the electricity purchase for the higher rate.",
    budget: { amountNgn: 100_000, priorSpendNgn: 90_000 },
    meterProfile: { profile: "extra_occupancy", magnitude: 0.5 },
    utilities: {
      electricity: { balance: 8, perHour: 0.32, multiplier: 2.6, recentPerHour: 0.84, recentHours: 8 },
      airtime: { balance: 900, perHour: 3 },
      data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 },
    },
  },
  {
    id: "surge-not-urgent",
    name: "Electricity use up, not urgent",
    summary: "Electricity use has tripled, but the meter still has nearly three days left.",
    expect: "Borderless decides a diagnostic isn't worth buying yet — no purchase depends on the cause — flags the change and keeps watching.",
    budget: { amountNgn: 100_000, priorSpendNgn: 90_000 },
    meterProfile: { profile: "stuck_water_heater", magnitude: 0.68 },
    utilities: {
      electricity: { balance: 65, perHour: 0.32, multiplier: 3.1, recentPerHour: 1.0, recentHours: 8 },
      airtime: { balance: 900, perHour: 3 },
      data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 },
    },
  },
  {
    id: "surge-tight-budget",
    name: "Electricity use up, budget nearly gone",
    summary: "Electricity use has tripled and the meter is low, but only 0.60 USDC of the budget is left.",
    expect: "Borderless won't spend on a diagnostic that couldn't change anything: no electricity purchase fits the budget. It asks you to review instead.",
    budget: { amountNgn: 100_000, priorSpendNgn: 99_400 },
    meterProfile: { profile: "stuck_water_heater", magnitude: 0.68 },
    utilities: {
      electricity: { balance: 9, perHour: 0.32, multiplier: 3.1, recentPerHour: 1.0, recentHours: 8 },
      airtime: { balance: 900, perHour: 3 },
      data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 },
    },
  },
  {
    id: "authority-revoked",
    name: "Authority revoked",
    summary: "Automatic purchasing is off while electricity runs low.",
    expect: "Borderless keeps monitoring and recommends a purchase, but spends nothing.",
    budget: { amountNgn: 100_000, priorSpendNgn: 92_000 },
    policy: { autoPurchaseEnabled: false },
    utilities: { ...BASE_UTILITIES, data: { balance: 2_500, perHour: 22, expiresInHours: 9 * 24 } },
  },
];

/** A clean start is the primary live demo. */
export const DEFAULT_SCENARIO_ID = "primary-electricity";

export function scenarioById(id: string | undefined): ScenarioDefinition {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS.find((s) => s.id === DEFAULT_SCENARIO_ID)!;
}
