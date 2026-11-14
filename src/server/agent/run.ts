/**
 * Agent orchestration: snapshot → decide → explain → persist → act.
 *
 * The decision record is written BEFORE any purchase is created, so every purchase
 * can be traced back to the exact inputs and reasoning that caused it.
 */
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { MobileNetwork, UtilityKind } from "../db/schema";
import { loadHousehold } from "../household/state";
import { newId } from "../lib/ids";
import { executePurchase, type BuyerOptions, type ExecuteResult } from "../payments/x402-buyer";
import { intelligenceProvidersFor, eligibleProvidersFor } from "../providers/registry";
import type { Product } from "../providers/types";
import { recordEvent } from "../transactions/events";
import { createPurchase, OPEN_STAGES, PolicyDeniedError, PurchaseConflictError } from "../transactions/purchases";
import { sweepInterruptedPurchases } from "../transactions/sweep";
import { forecast } from "../usage/forecast";
import { recentSamples } from "../usage/simulator";
import { decide, type Decision, type DecisionInput, type Diagnosis, type InformationOffer, type UtilitySnapshot } from "./engine";
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
  const accountOf = (kind: UtilityKind) => rows.find((r) => r.account.kind === kind)?.account;
  const servesAccount = (kind: UtilityKind, network: MobileNetwork | null) =>
    eligibleProvidersFor({ kind, network, distributionCompany: accountOf(kind)?.distributionCompany ?? null });

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

  // Paid information services that could explain each utility (e.g. meter diagnostics).
  const informationOffers = Object.fromEntries(
    utilities.map((u) => [
      u.kind,
      intelligenceProvidersFor(u.kind).map((m) => ({
        providerId: m.definition.id,
        name: m.definition.name,
        priceNgn: m.listProducts()[0]!.amountNgn,
        available: providerRows.find((r) => r.id === m.definition.id)?.available ?? false,
        detail: m.definition.offerSummary.toLowerCase().includes("circuit") ? ("detailed" as const) : ("basic" as const),
      })),
    ]),
  ) as Partial<Record<UtilityKind, InformationOffer[]>>;

  // The latest paid diagnosis per utility in the last 24 household hours, from its receipt.
  const recent = await db
    .select({ p: s.purchases, rcp: s.receipts })
    .from(s.purchases)
    .innerJoin(s.receipts, eq(s.receipts.purchaseId, s.purchases.id))
    .where(and(eq(s.purchases.householdId, householdId), eq(s.purchases.serviceType, "meter_diagnostic"), eq(s.purchases.fulfilmentStatus, "fulfilled"), gt(s.purchases.simTime, new Date(now.getTime() - 24 * 3_600_000))))
    .orderBy(desc(s.purchases.createdAt));
  const diagnoses: Partial<Record<UtilityKind, Diagnosis>> = {};
  for (const { p, rcp } of recent) {
    if (diagnoses[p.kind]) continue;
    const r = (rcp.payload as { fulfilment?: { details?: { result?: Record<string, unknown> } } }).fulfilment?.details?.result;
    if (!r || r.service !== "meter_diagnostic") continue;
    diagnoses[p.kind] = {
      purchaseId: p.id,
      providerId: p.providerId,
      finding: r.finding as Diagnosis["finding"],
      summary: String(r.summary ?? ""),
      ownerAction: (r.ownerAction as string | null) ?? null,
      expectedNormalPerHour: Number(r.expectedNormalKwhPerHour ?? 0),
      observedPerHour: Number(r.observedKwhPerHour ?? 0),
    };
  }

  return { now, utilities, priorities: state.priorities, policy: state.policy, budget: state.budget, ledger: state.ledger, products, informationOffers, diagnoses };
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

/** The owner paused Borderless: it neither assesses nor buys until resumed. */
export class AgentPausedError extends Error {
  readonly code = "agent_paused";
  constructor() {
    super("Borderless is paused. Resume it from Settings (or the Overview) to let it work again.");
  }
}

export async function agentPaused(db: Database, householdId: string): Promise<boolean> {
  const [row] = await db.select({ paused: s.agentPolicies.agentPaused }).from(s.agentPolicies).where(eq(s.agentPolicies.householdId, householdId));
  return !!row?.paused;
}

export async function runAgent(
  db: Database,
  householdId: string,
  opts: { trigger?: "tick" | "manual" | "scenario"; execute?: boolean; buyer?: BuyerOptions } = {},
): Promise<AgentRunResult> {
  if (running.has(householdId)) throw new AgentBusyError("Borderless is already assessing this household.");
  if (await agentPaused(db, householdId)) throw new AgentPausedError();
  running.add(householdId);
  try {
    // Close out purchases interrupted by a crash/restart before deciding anything new.
    await sweepInterruptedPurchases(db, householdId);
    return await assessAndAct(db, householdId, opts, 0);
  } finally {
    running.delete(householdId);
  }
}

/**
 * One assessment: decide, record, then act. If the decision is to buy information first
 * (a meter diagnostic), buy it through x402 and assess again with the report in hand —
 * at most once per run, so the agent never loops buying information.
 */
async function assessAndAct(
  db: Database,
  householdId: string,
  opts: { trigger?: "tick" | "manual" | "scenario"; execute?: boolean; buyer?: BuyerOptions },
  depth: number,
): Promise<AgentRunResult> {
  {
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
      selectedAction: serialisable({ selected: decision.selected, deferred: decision.deferred, flags: decision.flags, options: decision.options, notNeeded: decision.notNeeded, information: decision.information }),
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

    // Buy information the decision needs before it can size a purchase, then reassess.
    const toBuy = depth === 0 && opts.execute !== false ? decision.information.filter((i) => i.action === "buy" && i.providerId) : [];
    let learned = false;
    for (const info of toBuy) {
      try {
        const p = await createPurchase(db, {
          householdId,
          kind: info.kind,
          providerId: info.providerId!,
          productCode: "meter_diagnostic",
          initiatedBy: "agent",
          decisionId,
          idempotencyKey: `${decisionId}:info:${info.kind}`,
        });
        if (p.stage === "awaiting_approval") {
          awaitingApproval.push(p.id);
          continue;
        }
        const r = await executePurchase(db, p.id, opts.buyer);
        purchases.push(r);
        if (r.stage === "completed") learned = true;
      } catch (err) {
        if (err instanceof PolicyDeniedError || err instanceof PurchaseConflictError) {
          await recordEvent(db, { householdId, decisionId, category: "decision", type: "purchase.refused", severity: "warning", title: `${info.kind} diagnostic not bought`, detail: err.message, simTime });
          continue;
        }
        throw err;
      }
    }
    if (learned) {
      const next = await assessAndAct(db, householdId, opts, depth + 1);
      return { ...next, purchases: [...purchases, ...next.purchases], awaitingApproval: [...awaitingApproval, ...next.awaitingApproval] };
    }

    return { decisionId, decision, explanation, purchases, awaitingApproval };
  }
}
