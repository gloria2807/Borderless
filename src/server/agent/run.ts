/**
 * Agent orchestration: snapshot → decide → explain → persist → act.
 *
 * The decision record is written BEFORE any purchase is created, so every purchase
 * can be traced back to the exact inputs and reasoning that caused it.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { MobileNetwork, UtilityKind } from "../db/schema";
import { loadHousehold } from "../household/state";
import { newId } from "../lib/ids";
import { executePurchase, type BuyerOptions, type ExecuteResult } from "../payments/x402-buyer";
import { providersFor } from "../providers/registry";
import type { Product } from "../providers/types";
import { recordEvent } from "../transactions/events";
import { createPurchase, OPEN_STAGES, PolicyDeniedError, PurchaseConflictError } from "../transactions/purchases";
import { sweepInterruptedPurchases } from "../transactions/sweep";
import { forecast } from "../usage/forecast";
import { recentSamples } from "../usage/simulator";
import { decide, type Decision, type DecisionInput, type UtilitySnapshot } from "./engine";
import { explain, formatDuration, formatQuantity, type Explanation } from "./explain";

export interface AgentRunResult {
  decisionId: string;
  decision: Decision;
  explanation: Explanation;
  purchases: ExecuteResult[];
  /** Purchases created but parked for owner approval. */
  awaitingApproval: string[];
}

export async function buildDecisionInput(db: Database, householdId: string): Promise<DecisionInput> {
  const state = await loadHousehold(db, householdId);
  const now = state.household.simulatedNow;
  const rows = await db
    .select({ account: s.utilityAccounts, balance: s.utilityBalances, provider: s.utilityProviders })
    .from(s.utilityAccounts)
    .innerJoin(s.utilityBalances, eq(s.utilityBalances.accountId, s.utilityAccounts.id))
    .innerJoin(s.utilityProviders, eq(s.utilityProviders.id, s.utilityAccounts.providerId))
    .where(eq(s.utilityAccounts.householdId, householdId));
  const open = await db
    .select({ id: s.purchases.id, accountId: s.purchases.accountId, stage: s.purchases.stage, amountNgn: s.purchases.amountNgn })
    .from(s.purchases)
    .where(and(eq(s.purchases.householdId, householdId), inArray(s.purchases.stage, OPEN_STAGES)));

  const providerRows = await db.select().from(s.utilityProviders);
  const servesAccount = (kind: UtilityKind, network: MobileNetwork | null) =>
    providersFor(kind).filter((m) => kind === "electricity" || (network !== null && m.definition.networks.includes(network)));

  const utilities: UtilitySnapshot[] = [];
  for (const { account, balance, provider } of rows) {
    const samples = await recentSamples(db, account.id, now);
    const o = open.find((p) => p.accountId === account.id);
    utilities.push({
      kind: account.kind,
      accountId: account.id,
      providerId: provider.id,
      providerName: provider.name,
      providerAvailable: provider.available,
      providers: Object.fromEntries(
        servesAccount(account.kind, account.network).map((m) => [m.definition.id, { name: m.definition.name, available: providerRows.find((r) => r.id === m.definition.id)?.available ?? false }]),
      ),
      network: account.network,
      forecast: forecast(
        { kind: account.kind, balance: balance.balance, unit: balance.unit, baselinePerHour: balance.baselineUsagePerHour, expiresAt: balance.expiresAt },
        samples,
        now,
      ),
      openPurchase: o ? { id: o.id, stage: o.stage, amountNgn: o.amountNgn } : null,
    });
  }

  // Products from every provider that can serve each account (several providers compete).
  const products = Object.fromEntries(
    utilities.map((u) => [u.kind, servesAccount(u.kind, u.network).flatMap((m) => m.listProducts())]),
  ) as Record<UtilityKind, Product[]>;

  return { now, utilities, priorities: state.priorities, policy: state.policy, budget: state.budget, ledger: state.ledger, products };
}

/** JSON-safe snapshot for the audit record (Infinity → null). */
function serialisable<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));
}

const globalRuns = globalThis as unknown as { __borderlessAgentRuns?: Set<string> };
const running = (globalRuns.__borderlessAgentRuns ??= new Set());

export class AgentBusyError extends Error {
  readonly code = "agent_busy";
}

export async function runAgent(
  db: Database,
  householdId: string,
  opts: { trigger?: "tick" | "manual" | "scenario"; execute?: boolean; buyer?: BuyerOptions } = {},
): Promise<AgentRunResult> {
  if (running.has(householdId)) throw new AgentBusyError("Borderless is already assessing this household.");
  running.add(householdId);
  try {
    // Close out purchases interrupted by a crash/restart before deciding anything new.
    await sweepInterruptedPurchases(db, householdId);
    const input = await buildDecisionInput(db, householdId);
    const decision = decide(input);
    const explanation = explain(decision);
    const decisionId = newId("dec");
    const simTime = input.now;

    await db.insert(s.agentDecisions).values({
      id: decisionId,
      householdId,
      simTime,
      trigger: opts.trigger ?? "manual",
      inputSnapshot: serialisable({
        now: input.now,
        priorities: input.priorities,
        policy: input.policy,
        budget: input.budget,
        utilities: input.utilities,
        ledgerSize: input.ledger.length,
      }),
      shortages: serialisable(decision.assessments.filter((a) => a.needsAction).map((a) => ({ kind: a.kind, urgency: a.urgency, hoursRemaining: a.forecast.hoursRemaining }))),
      urgency: serialisable(decision.assessments.map(({ forecast: f, ...a }) => ({ ...a, hoursRemaining: f.hoursRemaining, usageRatio: f.usageRatio }))),
      candidates: serialisable(decision.candidates),
      selectedAction: serialisable({ selected: decision.selected, deferred: decision.deferred, flags: decision.flags, options: decision.options, notNeeded: decision.notNeeded }),
      reasoning: explanation.reasoning,
      budgetImpact: serialisable(decision.budgetImpact),
      outcome: decision.outcome,
    });

    // Timeline: what was noticed and predicted, then what was decided.
    for (const a of decision.assessments.filter((x) => x.needsAction || x.forecast.unusualUsage)) {
      const f = a.forecast;
      await recordEvent(db, {
        householdId,
        decisionId,
        category: f.unusualUsage ? "observation" : "prediction",
        type: f.unusualUsage ? "usage.unusual" : `shortage.${a.urgency}`,
        severity: a.urgency === "critical" ? "critical" : "warning",
        title: f.unusualUsage
          ? `${a.kind === "data" ? "Data" : a.kind[0]!.toUpperCase() + a.kind.slice(1)} use is ${f.usageRatio.toFixed(1)}× the usual rate`
          : `${a.kind[0]!.toUpperCase() + a.kind.slice(1)} ${a.urgency === "critical" ? "critically low" : "running low"}`,
        detail: `${formatQuantity(f.balance, f.unit)} left — ${f.balance <= 0 ? "already out" : `likely ${formatDuration(f.hoursRemaining)} of service`}.`,
        data: { kind: a.kind, urgency: a.urgency, balance: f.balance, hoursRemaining: Number.isFinite(f.hoursRemaining) ? f.hoursRemaining : null },
        simTime,
      });
    }
    await recordEvent(db, {
      householdId,
      decisionId,
      category: "decision",
      type: `decision.${decision.outcome}`,
      severity: decision.outcome === "blocked" ? "warning" : decision.outcome === "flagged" ? "warning" : "info",
      title: explanation.headline,
      detail: explanation.reasoning,
      data: { lines: explanation.lines, budgetImpact: decision.budgetImpact },
      simTime,
    });

    // Act on the plan. Purchases go through the same authority gate again.
    const purchases: ExecuteResult[] = [];
    const awaitingApproval: string[] = [];
    for (const plan of decision.selected) {
      let purchaseId: string;
      try {
        const p = await createPurchase(db, {
          householdId,
          kind: plan.kind,
          ...(plan.kind === "data" ? { productCode: plan.product.code } : { amountNgn: plan.product.amountNgn }),
          providerId: plan.product.providerId,
          initiatedBy: "agent",
          decisionId,
          idempotencyKey: `${decisionId}:${plan.kind}`,
        });
        purchaseId = p.id;
        if (p.stage === "awaiting_approval") {
          awaitingApproval.push(p.id);
          continue;
        }
      } catch (err) {
        if (err instanceof PolicyDeniedError || err instanceof PurchaseConflictError) {
          await recordEvent(db, { householdId, decisionId, category: "decision", type: "purchase.refused", severity: "warning", title: `${plan.kind} purchase not started`, detail: err.message, simTime });
          continue;
        }
        throw err;
      }
      if (opts.execute !== false) purchases.push(await executePurchase(db, purchaseId, opts.buyer));
    }

    return { decisionId, decision, explanation, purchases, awaitingApproval };
  } finally {
    running.delete(householdId);
  }
}
