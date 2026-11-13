import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { PurchaseStage, UtilityKind } from "../db/schema";
import { evaluateSpendingAuthority, type PolicyCheck, type Violation } from "../household/policy";
import { loadHousehold } from "../household/state";
import { newId } from "../lib/ids";
import { resolveProviderProduct } from "../providers/registry";
import { recordEvent } from "./events";

/** Stages that hold the utility "busy" — a new purchase for the same account must wait. */
/** Used when a household has no explicit approval window. */
export const DEFAULT_APPROVAL_TTL_SECONDS = 180;

export const OPEN_STAGES: PurchaseStage[] = ["awaiting_approval", "requested", "payment_required", "submitted", "needs_attention"];

export class PolicyDeniedError extends Error {
  readonly code = "policy_denied";
  constructor(
    readonly violations: Violation[],
    readonly checks: PolicyCheck[] = [],
  ) {
    super(violations.map((v) => v.message).join(" "));
  }
}

export class PurchaseConflictError extends Error {
  readonly code = "purchase_in_progress";
  constructor(readonly existingPurchaseId: string) {
    super("A purchase for this utility is already in progress.");
  }
}

export interface CreatePurchaseInput {
  householdId: string;
  kind: UtilityKind;
  amountNgn?: number;
  productCode?: string;
  initiatedBy: "agent" | "owner" | "script";
  decisionId?: string;
  idempotencyKey?: string;
  /** Agent run making this purchase (task budget applies). */
  runId?: string;
  /** Which provider to buy from (defaults to the account's provider). */
  providerId?: string;
  /** Provider quote this purchase redeems (the buyer re-validates it before signing). */
  quote?: { quoteId: string; amountAtomic: string; payTo: string; expiresAt: Date };
}

export type PurchaseRow = typeof s.purchases.$inferSelect;

/**
 * Create a purchase after enforcing spending authority. Runs in an IMMEDIATE
 * transaction so concurrent creators cannot both pass the budget check.
 */
export async function createPurchase(db: Database, input: CreatePurchaseInput): Promise<PurchaseRow> {
  return db.transaction(
    async (tx) => {
      const txDb = tx as unknown as Database;
      if (input.idempotencyKey) {
        const [dup] = await tx.select().from(s.purchases).where(eq(s.purchases.idempotencyKey, input.idempotencyKey));
        if (dup) return dup;
      }

      const state = await loadHousehold(txDb, input.householdId);
      const [account] = await tx
        .select()
        .from(s.utilityAccounts)
        .where(and(eq(s.utilityAccounts.householdId, input.householdId), eq(s.utilityAccounts.kind, input.kind)));
      if (!account) throw new Error(`Household has no ${input.kind} account`);
      const providerId = input.providerId ?? account.providerId;
      const [provider] = await tx.select().from(s.utilityProviders).where(eq(s.utilityProviders.id, providerId));
      if (!provider || provider.kind !== input.kind) throw new Error(`Provider ${providerId} does not serve ${input.kind}`);

      const [open] = await tx
        .select({ id: s.purchases.id })
        .from(s.purchases)
        .where(and(eq(s.purchases.accountId, account.id), inArray(s.purchases.stage, OPEN_STAGES)));
      if (open) throw new PurchaseConflictError(open.id);

      const product = resolveProviderProduct(provider.id, input);
      const authority = evaluateSpendingAuthority(
        {
          kind: input.kind,
          providerId: provider.id,
          providerAvailable: provider.available,
          network: account.network,
          amountNgn: product.amountNgn,
          initiatedBy: input.initiatedBy,
        },
        state.policy,
        state.budget,
        state.ledger,
        state.household.simulatedNow,
        undefined,
        { runId: input.runId },
      );
      if (authority.outcome === "deny") throw new PolicyDeniedError(authority.violations, authority.checks);

      const id = newId("pur");
      const stage: PurchaseStage = authority.outcome === "require_approval" ? "awaiting_approval" : "requested";
      const [row] = await tx
        .insert(s.purchases)
        .values({
          id,
          householdId: input.householdId,
          decisionId: input.decisionId ?? null,
          runId: input.runId ?? null,
          quoteId: input.quote?.quoteId ?? null,
          quoteAmountAtomic: input.quote?.amountAtomic ?? null,
          quotePayTo: input.quote?.payTo ?? null,
          quoteExpiresAt: input.quote?.expiresAt ?? null,
          accountId: account.id,
          providerId: provider.id,
          kind: input.kind,
          productCode: product.code,
          amountNgn: product.amountNgn,
          quantity: product.quantity,
          unit: product.unit,
          idempotencyKey: input.idempotencyKey ?? id,
          initiatedBy: input.initiatedBy,
          stage,
          approvalExpiresAt: stage === "awaiting_approval" ? new Date(Date.now() + (state.policy.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS) * 1000) : null,
          paymentStatus: "not_started",
          fulfilmentStatus: "not_started",
          simTime: state.household.simulatedNow,
        })
        .returning();

      await recordEvent(tx, {
        householdId: input.householdId,
        purchaseId: id,
        decisionId: input.decisionId,
        category: "decision",
        type: stage === "awaiting_approval" ? "purchase.awaiting_approval" : "purchase.created",
        severity: stage === "awaiting_approval" ? "warning" : "info",
        title:
          stage === "awaiting_approval"
            ? `${product.label} needs your approval`
            : `Purchase prepared: ${product.label}`,
        detail:
          stage === "awaiting_approval"
            ? `₦${product.amountNgn.toLocaleString("en-NG")} is above your ₦${state.policy.manualApprovalThresholdNgn.toLocaleString("en-NG")} approval threshold.`
            : `Within limits. ₦${(authority.summary.remainingNgn - product.amountNgn).toLocaleString("en-NG")} of the budget will remain.`,
        simTime: state.household.simulatedNow,
      });
      return row!;
    },
    { behavior: "immediate" },
  );
}
