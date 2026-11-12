/**
 * Recovery for purchases interrupted by a crash or restart.
 *
 * Safety argument: the buyer moves a purchase to `submitted` BEFORE it sends the
 * signed payment. So a purchase still in `requested` or `payment_required` never
 * sent a payment and cannot have been charged — it is safe to close as failed.
 * A purchase stuck in `submitted` MAY have been charged, so it is never failed
 * blindly: it moves to `needs_attention` with an unknown payment outcome, to be
 * reconciled (provider settlement record + chain) without paying again.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import { recordEvent } from "./events";

/** A purchase step that has not progressed for this long (wall time) is considered interrupted. */
export const STALE_AFTER_MS = 3 * 60_000;

export async function sweepInterruptedPurchases(db: Database, householdId: string, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - STALE_AFTER_MS);
  const stale = await db
    .select()
    .from(s.purchases)
    .where(and(eq(s.purchases.householdId, householdId), inArray(s.purchases.stage, ["requested", "payment_required", "submitted"]), lt(s.purchases.updatedAt, cutoff)));

  for (const p of stale) {
    const neverSent = p.stage !== "submitted";
    await db
      .update(s.purchases)
      .set(
        neverSent
          ? { stage: "failed", paymentStatus: "failed", failureCode: "interrupted", failureMessage: "Interrupted before any payment was sent. Nothing was charged.", updatedAt: new Date() }
          : { stage: "needs_attention", paymentStatus: "unknown", failureCode: "interrupted_after_submit", failureMessage: "Interrupted after the payment was sent. The outcome will be reconciled before anything is retried.", updatedAt: new Date() },
      )
      .where(and(eq(s.purchases.id, p.id), eq(s.purchases.stage, p.stage)));
    await db.update(s.payments).set({ status: neverSent ? "failed" : "unknown", updatedAt: new Date() }).where(eq(s.payments.purchaseId, p.id));
    const [hh] = await db.select({ simNow: s.households.simulatedNow }).from(s.households).where(eq(s.households.id, householdId));
    await recordEvent(db, {
      householdId,
      purchaseId: p.id,
      category: "payment",
      type: neverSent ? "payment.interrupted_not_charged" : "payment.interrupted_unknown",
      severity: neverSent ? "info" : "warning",
      title: neverSent ? "Interrupted purchase closed, not charged" : "Interrupted payment needs reconciling",
      detail: neverSent ? "The purchase stopped before a payment was sent." : "The payment had been sent when the purchase was interrupted.",
      simTime: hh?.simNow ?? new Date(),
    });
  }
  return stale.length;
}
