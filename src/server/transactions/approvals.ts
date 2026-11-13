/**
 * Owner decisions on purchases the agent parked above the approval threshold.
 * Approval lifts only the approval threshold — never budget, per-purchase or
 * overall-authority limits, which are re-checked here and again before signing.
 */
import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import { evaluateSpendingAuthority } from "../household/policy";
import { loadHousehold } from "../household/state";
import { recordEvent } from "./events";
import { PolicyDeniedError } from "./purchases";
import { appendRunEvent } from "../agent/runtime/run-log";

export class ApprovalStateError extends Error {
  readonly code = "not_awaiting_approval";
}

export class ApprovalExpiredError extends Error {
  readonly code = "approval_expired";
}

/**
 * Close every parked purchase whose approval window has passed. It is cancelled unpaid:
 * an old approval request must never be approved against stale prices or a changed
 * household. Returns the purchases expired.
 */
export async function expireApprovals(db: Database, householdId: string, now = Date.now()): Promise<string[]> {
  const due = await db
    .select()
    .from(s.purchases)
    .where(and(eq(s.purchases.householdId, householdId), eq(s.purchases.stage, "awaiting_approval"), lte(s.purchases.approvalExpiresAt, new Date(now))));
  const expired: string[] = [];
  for (const p of due) {
    const changed = await db
      .update(s.purchases)
      .set({ stage: "cancelled", failureCode: "approval_expired", failureMessage: "The approval request expired before the owner answered. Nothing was paid.", updatedAt: new Date() })
      .where(and(eq(s.purchases.id, p.id), eq(s.purchases.stage, "awaiting_approval")))
      .returning({ id: s.purchases.id });
    if (!changed.length) continue;
    expired.push(p.id);
    const [hh] = await db.select({ simNow: s.households.simulatedNow }).from(s.households).where(eq(s.households.id, householdId));
    await recordEvent(db, {
      householdId,
      purchaseId: p.id,
      decisionId: p.decisionId ?? undefined,
      category: "decision",
      type: "purchase.approval_expired",
      severity: "info",
      title: "Approval request expired",
      detail: `₦${p.amountNgn.toLocaleString("en-NG")} ${p.kind} was not approved in time. Nothing was paid; Borderless will reassess.`,
      simTime: hh?.simNow ?? new Date(),
    });
    if (p.runId) await appendRunEvent(db, p.runId, { stage: "awaiting_approval", type: "approval.expired", utility: p.kind, purchaseId: p.id, decision: "expired", reason: "The owner did not answer before the approval window closed. Nothing was paid." });
  }
  return expired;
}

export async function approvePurchase(db: Database, purchaseId: string): Promise<void> {
  const [parked] = await db.select().from(s.purchases).where(eq(s.purchases.id, purchaseId));
  if (parked?.stage === "awaiting_approval" && parked.approvalExpiresAt && parked.approvalExpiresAt.getTime() <= Date.now()) {
    await expireApprovals(db, parked.householdId);
    throw new ApprovalExpiredError("This approval request has expired. Nothing was paid; ask Borderless to reassess.");
  }
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
  if (p?.stage === "awaiting_approval" && p.approvalExpiresAt && p.approvalExpiresAt.getTime() <= Date.now()) {
    await expireApprovals(db, p.householdId);
    throw new ApprovalExpiredError("This approval request had already expired. Nothing was paid.");
  }
  if (!p || p.stage !== "awaiting_approval") throw new ApprovalStateError("This purchase is not waiting for approval.");
  const [hh] = await db.select().from(s.households).where(eq(s.households.id, p.householdId));
  await db
    .update(s.purchases)
    .set({ stage: "cancelled", failureCode: "declined_by_owner", failureMessage: "Declined by the household owner.", updatedAt: new Date() })
    .where(eq(s.purchases.id, purchaseId));
  if (p.runId) await appendRunEvent(db, p.runId, { stage: "awaiting_approval", type: "approval.declined", utility: p.kind, purchaseId, decision: "declined", reason: "The owner declined. Nothing was paid." });
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
