/**
 * Owner decisions on purchases the agent parked above the approval threshold.
 * Approval lifts only the approval threshold — never budget, per-purchase or
 * overall-authority limits, which are re-checked here and again before signing.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import { evaluateSpendingAuthority } from "../household/policy";
import { loadHousehold } from "../household/state";
import { recordEvent } from "./events";
import { PolicyDeniedError } from "./purchases";

export class ApprovalStateError extends Error {
  readonly code = "not_awaiting_approval";
}

export async function approvePurchase(db: Database, purchaseId: string): Promise<void> {
  await db.transaction(
    async (tx) => {
      const txDb = tx as unknown as Database;
      const [p] = await tx.select().from(s.purchases).where(eq(s.purchases.id, purchaseId));
      if (!p || p.stage !== "awaiting_approval") throw new ApprovalStateError("This purchase is not waiting for approval.");
      const state = await loadHousehold(txDb, p.householdId);
      const [account] = await tx.select().from(s.utilityAccounts).where(eq(s.utilityAccounts.id, p.accountId));
      const [provider] = await tx.select().from(s.utilityProviders).where(eq(s.utilityProviders.id, p.providerId));
      const authority = evaluateSpendingAuthority(
        {
          kind: p.kind,
          providerId: p.providerId,
          providerAvailable: provider?.available ?? false,
          network: account?.network ?? null,
          amountNgn: p.amountNgn,
          initiatedBy: p.initiatedBy,
          ownerApproved: true,
        },
        state.policy,
        state.budget,
        state.ledger,
        state.household.simulatedNow,
        p.id,
      );
      if (authority.outcome === "deny") throw new PolicyDeniedError(authority.violations);

      await tx.update(s.purchases).set({ stage: "requested", updatedAt: new Date() }).where(eq(s.purchases.id, purchaseId));
      await recordEvent(tx, {
        householdId: p.householdId,
        purchaseId,
        decisionId: p.decisionId ?? undefined,
        category: "decision",
        type: "purchase.approved",
        severity: "success",
        title: "You approved the purchase",
        detail: `₦${p.amountNgn.toLocaleString("en-NG")} ${p.kind}. Borderless will pay now.`,
        simTime: state.household.simulatedNow,
      });
    },
    { behavior: "immediate" },
  );
}

export async function declinePurchase(db: Database, purchaseId: string): Promise<void> {
  const [p] = await db.select().from(s.purchases).where(eq(s.purchases.id, purchaseId));
  if (!p || p.stage !== "awaiting_approval") throw new ApprovalStateError("This purchase is not waiting for approval.");
  const [hh] = await db.select().from(s.households).where(eq(s.households.id, p.householdId));
  await db
    .update(s.purchases)
    .set({ stage: "cancelled", failureCode: "declined_by_owner", failureMessage: "Declined by the household owner.", updatedAt: new Date() })
    .where(eq(s.purchases.id, purchaseId));
  await recordEvent(db, {
    householdId: p.householdId,
    purchaseId,
    decisionId: p.decisionId ?? undefined,
    category: "decision",
    type: "purchase.declined",
    severity: "info",
    title: "You declined the purchase",
    detail: "Nothing was paid.",
    simTime: hh?.simulatedNow ?? new Date(),
  });
}
