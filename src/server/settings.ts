/** Owner-controlled settings: household name, budget and the agent's spending authority. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./db/client";
import * as s from "./db/schema";
import { MOBILE_NETWORKS, UTILITY_KINDS } from "./db/schema";
import { ALL_PROVIDERS } from "./providers/registry";
import { recordEvent } from "./transactions/events";

export const settingsSchema = z
  .object({
    householdName: z.string().trim().min(1).max(60),
    budgetAmountNgn: z.number().int().min(0).max(10_000_000),
    budgetPeriod: z.enum(["weekly", "monthly"]),
    autoPurchaseEnabled: z.boolean(),
    perPurchaseLimitNgn: z.number().int().min(0).max(1_000_000),
    overallAgentLimitNgn: z.number().int().min(0).max(10_000_000),
    manualApprovalThresholdNgn: z.number().int().min(0).max(1_000_000),
    priorities: z.array(z.enum(UTILITY_KINDS)).length(3),
    approvedServices: z.array(z.enum(UTILITY_KINDS)).max(3),
    approvedNetworks: z.array(z.enum(MOBILE_NETWORKS)).max(4),
    // Allocation rules (optional so older clients keep working; omitted = unchanged).
    dailyAgentBudgetNgn: z.number().int().min(0).max(10_000_000).optional(),
    taskBudgetNgn: z.number().int().min(0).max(10_000_000).optional(),
    reserveNgn: z.number().int().min(0).max(10_000_000).optional(),
    /** Seconds a parked purchase waits for the owner (10 s for demos, up to a day). */
    approvalTtlSeconds: z.number().int().min(10).max(86_400).optional(),
    /** Per-utility cap per purchase; 0 or absent = no cap beyond the per-purchase limit. */
    maxPerUtilityNgn: z.record(z.enum(UTILITY_KINDS), z.number().int().min(0).max(1_000_000)).optional(),
  })
  .refine((v) => new Set(v.priorities).size === 3, { message: "Each utility must appear once in priorities", path: ["priorities"] });

export type SettingsInput = z.infer<typeof settingsSchema>;

const DAY = 86_400_000;

/** Budget period containing `now`. Weeks start on Monday (WAT ≈ UTC for day boundaries here). */
export function periodFor(period: "weekly" | "monthly", now: Date): { start: Date; end: Date } {
  if (period === "monthly") {
    return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
  }
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - day * DAY);
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}

export async function updateSettings(db: Database, householdId: string, input: SettingsInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [hh] = await tx.select().from(s.households).where(eq(s.households.id, householdId));
    if (!hh) throw new Error("Household not found");
    const [budget] = await tx.select().from(s.householdBudgets).where(and(eq(s.householdBudgets.householdId, householdId), eq(s.householdBudgets.active, true)));
    const [before] = await tx.select().from(s.agentPolicies).where(eq(s.agentPolicies.householdId, householdId));

    await tx.update(s.households).set({ name: input.householdName, updatedAt: new Date() }).where(eq(s.households.id, householdId));
    if (budget) {
      const window = budget.period === input.budgetPeriod ? { start: budget.periodStart, end: budget.periodEnd } : periodFor(input.budgetPeriod, hh.simulatedNow);
      await tx
        .update(s.householdBudgets)
        .set({ amountNgn: input.budgetAmountNgn, period: input.budgetPeriod, periodStart: window.start, periodEnd: window.end, updatedAt: new Date() })
        .where(eq(s.householdBudgets.id, budget.id));
    }
    await tx
      .update(s.agentPolicies)
      .set({
        autoPurchaseEnabled: input.autoPurchaseEnabled,
        perPurchaseLimitNgn: input.perPurchaseLimitNgn,
        overallAgentLimitNgn: input.overallAgentLimitNgn,
        manualApprovalThresholdNgn: input.manualApprovalThresholdNgn,
        priorities: input.priorities,
        approvedServices: input.approvedServices,
        approvedNetworks: input.approvedNetworks,
        ...(input.dailyAgentBudgetNgn !== undefined ? { dailyAgentBudgetNgn: input.dailyAgentBudgetNgn } : {}),
        ...(input.taskBudgetNgn !== undefined ? { taskBudgetNgn: input.taskBudgetNgn } : {}),
        ...(input.reserveNgn !== undefined ? { reserveNgn: input.reserveNgn } : {}),
        ...(input.approvalTtlSeconds !== undefined ? { approvalTtlSeconds: input.approvalTtlSeconds } : {}),
        ...(input.maxPerUtilityNgn !== undefined
          ? { maxPerUtilityNgn: Object.fromEntries(Object.entries(input.maxPerUtilityNgn).filter(([, n]) => n > 0)) }
          : {}),
        // Providers follow the approved services (every demo provider of an approved service).
        approvedProviderIds: ALL_PROVIDERS.filter((m) => input.approvedServices.includes(m.definition.kind)).map((m) => m.definition.id),
        updatedAt: new Date(),
      })
      .where(eq(s.agentPolicies.householdId, householdId));

    const changes: string[] = [];
    if (before && before.autoPurchaseEnabled !== input.autoPurchaseEnabled) changes.push(input.autoPurchaseEnabled ? "automatic purchasing turned on" : "automatic purchasing turned off");
    if (before && before.perPurchaseLimitNgn !== input.perPurchaseLimitNgn) changes.push(`per-purchase limit ₦${input.perPurchaseLimitNgn.toLocaleString("en-NG")}`);
    if (before && before.overallAgentLimitNgn !== input.overallAgentLimitNgn) changes.push(`agent limit ₦${input.overallAgentLimitNgn.toLocaleString("en-NG")}`);
    if (before && before.manualApprovalThresholdNgn !== input.manualApprovalThresholdNgn) changes.push(`approval above ₦${input.manualApprovalThresholdNgn.toLocaleString("en-NG")}`);
    if (budget && budget.amountNgn !== input.budgetAmountNgn) changes.push(`budget ₦${input.budgetAmountNgn.toLocaleString("en-NG")}`);
    if (before && input.dailyAgentBudgetNgn !== undefined && before.dailyAgentBudgetNgn !== input.dailyAgentBudgetNgn) changes.push(`daily agent limit ₦${input.dailyAgentBudgetNgn.toLocaleString("en-NG")}`);
    if (before && input.taskBudgetNgn !== undefined && before.taskBudgetNgn !== input.taskBudgetNgn) changes.push(`per-run limit ₦${input.taskBudgetNgn.toLocaleString("en-NG")}`);
    if (before && input.reserveNgn !== undefined && before.reserveNgn !== input.reserveNgn) changes.push(`reserve ₦${input.reserveNgn.toLocaleString("en-NG")}`);
    if (before && before.priorities.join() !== input.priorities.join()) changes.push(`priorities ${input.priorities.join(" > ")}`);
    await recordEvent(tx, {
      householdId,
      category: "system",
      type: "settings.updated",
      severity: "info",
      title: "Spending rules updated by the owner",
      detail: changes.length ? changes.join("; ") : "No limits changed.",
      simTime: hh.simulatedNow,
    });
  });
}
