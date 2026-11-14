import { env } from "../config/env";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { BudgetRules, PolicyRules, PurchaseLedgerEntry } from "./policy";

export class HouseholdNotFoundError extends Error {
  readonly code = "household_not_found";
}

export async function loadHousehold(db: Database, householdId: string) {
  const [household] = await db.select().from(s.households).where(eq(s.households.id, householdId));
  if (!household) throw new HouseholdNotFoundError(`Household ${householdId} not found`);
  const [policyRow] = await db.select().from(s.agentPolicies).where(eq(s.agentPolicies.householdId, householdId));
  if (!policyRow) throw new HouseholdNotFoundError(`Household ${householdId} has no agent policy`);
  const [budgetRow] = await db
    .select()
    .from(s.householdBudgets)
    .where(and(eq(s.householdBudgets.householdId, householdId), eq(s.householdBudgets.active, true)))
    .orderBy(desc(s.householdBudgets.periodStart))
    .limit(1);
  if (!budgetRow) throw new HouseholdNotFoundError(`Household ${householdId} has no active budget`);

  const ledgerRows = await db
    .select({
      id: s.purchases.id,
      amountNgn: s.purchases.amountNgn,
      initiatedBy: s.purchases.initiatedBy,
      stage: s.purchases.stage,
      paymentStatus: s.purchases.paymentStatus,
      createdAt: s.purchases.simTime,
      runId: s.purchases.runId,
    })
    .from(s.purchases)
    .where(
      and(
        eq(s.purchases.householdId, householdId),
        gte(s.purchases.simTime, budgetRow.periodStart),
        lt(s.purchases.simTime, budgetRow.periodEnd),
      ),
    );

  const policy: PolicyRules = {
    autoPurchaseEnabled: policyRow.autoPurchaseEnabled,
    agentPaused: policyRow.agentPaused,
    ngnPerUsdc: env().DEMO_NGN_PER_TESTNET_USDC,
    perPurchaseLimitNgn: policyRow.perPurchaseLimitNgn,
    overallAgentLimitNgn: policyRow.overallAgentLimitNgn,
    manualApprovalThresholdNgn: policyRow.manualApprovalThresholdNgn,
    approvalTtlSeconds: policyRow.approvalTtlSeconds,
    approvedServices: policyRow.approvedServices,
    approvedNetworks: policyRow.approvedNetworks,
    approvedProviderIds: policyRow.approvedProviderIds,
    dailyAgentBudgetNgn: policyRow.dailyAgentBudgetNgn,
    taskBudgetNgn: policyRow.taskBudgetNgn,
    reserveNgn: policyRow.reserveNgn,
    intelligenceCapNgn: policyRow.intelligenceCapNgn,
    maxPerUtilityNgn: policyRow.maxPerUtilityNgn,
  };
  const budget: BudgetRules = {
    amountNgn: budgetRow.amountNgn,
    priorSpendNgn: budgetRow.priorSpendNgn,
    periodStart: budgetRow.periodStart,
    periodEnd: budgetRow.periodEnd,
    period: budgetRow.period,
  };
  const ledger: PurchaseLedgerEntry[] = ledgerRows;
  return { household, policy, priorities: policyRow.priorities, budget, budgetId: budgetRow.id, ledger };
}
