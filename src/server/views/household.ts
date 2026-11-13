/**
 * Read models for the UI. Server-only. Everything returned is plain, serialisable
 * data derived from the database — the UI never holds transaction state of its own.
 */
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { env } from "../config/env";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { summariseBudget } from "../household/policy";
import { loadHousehold } from "../household/state";
import { explorerTxUrl } from "../payments/horizon";
import { TESTNET_USDC } from "../payments/pricing";
import { ALL_PROVIDERS, requireProvider } from "../providers/registry";
import { forecast, type Forecast } from "../usage/forecast";
import { recentSamples } from "../usage/simulator";
import type { ExplanationLine } from "../agent/explain";
import { DEMO_FAULTS, type DemoFaultKey } from "../demo/faults";
import { DEFAULT_SCENARIO_ID, SCENARIOS } from "../demo/scenarios";

const HOUR = 3_600_000;
const finite = (n: number) => (Number.isFinite(n) ? n : null);

export type ForecastView = Omit<Forecast, "hoursToDepletion" | "hoursRemaining" | "depletesAt"> & {
  hoursToDepletion: number | null;
  hoursRemaining: number | null;
  depletesAt: string | null;
};

export interface LastPurchaseView {
  id: string;
  amountNgn: number;
  quantity: number;
  unit: string;
  label: string;
  at: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  demoToken: string | null;
  reference: string | null;
}

export interface UtilityView {
  kind: UtilityKind;
  accountId: string;
  label: string;
  identifier: string;
  network: string | null;
  providerName: string;
  providerAvailable: boolean;
  balance: number;
  unit: "kWh" | "NGN" | "MB";
  usageMultiplier: number;
  activeBundle: string | null;
  expiresAt: string | null;
  forecast: ForecastView;
  usedLast24h: number;
  hourly: { at: string; used: number }[];
  lastPurchase: LastPurchaseView | null;
  history: LastPurchaseView[];
}

function forecastView(f: Forecast): ForecastView {
  return { ...f, hoursToDepletion: finite(f.hoursToDepletion), hoursRemaining: finite(f.hoursRemaining), depletesAt: f.depletesAt?.toISOString() ?? null };
}

export async function getUtilities(householdId: string, simNow: Date): Promise<UtilityView[]> {
  const database = db();
  const rows = await database
    .select({ account: s.utilityAccounts, balance: s.utilityBalances, provider: s.utilityProviders })
    .from(s.utilityAccounts)
    .innerJoin(s.utilityBalances, eq(s.utilityBalances.accountId, s.utilityAccounts.id))
    .innerJoin(s.utilityProviders, eq(s.utilityProviders.id, s.utilityAccounts.providerId))
    .where(eq(s.utilityAccounts.householdId, householdId));

  const order: UtilityKind[] = ["electricity", "airtime", "data"];
  const out: UtilityView[] = [];
  for (const { account, balance, provider } of rows.sort((a, b) => order.indexOf(a.account.kind) - order.indexOf(b.account.kind))) {
    const samples = await recentSamples(database, account.id, simNow, 24);
    const f = forecast({ kind: account.kind, balance: balance.balance, unit: balance.unit, baselinePerHour: balance.baselineUsagePerHour, expiresAt: balance.expiresAt }, samples, simNow);

    // Hourly consumption for the last 24 simulated hours.
    const hourly: { at: string; used: number }[] = [];
    for (let h = 23; h >= 0; h -= 1) {
      const end = simNow.getTime() - h * HOUR;
      const used = samples.filter((x) => x.delta > 0 && x.simTime.getTime() > end - HOUR && x.simTime.getTime() <= end).reduce((t, x) => t + x.delta, 0);
      hourly.push({ at: new Date(end).toISOString(), used: Math.round(used * 1000) / 1000 });
    }

    const fulfilled = await database
      .select({ purchase: s.purchases, receipt: s.receipts })
      .from(s.purchases)
      .leftJoin(s.receipts, eq(s.receipts.purchaseId, s.purchases.id))
      .where(and(eq(s.purchases.accountId, account.id), eq(s.purchases.fulfilmentStatus, "fulfilled")))
      .orderBy(desc(s.purchases.createdAt))
      .limit(6);
    const history: LastPurchaseView[] = fulfilled.map(({ purchase, receipt }) => {
      const f = (receipt?.payload as { fulfilment?: { balanceBefore?: number; balanceAfter?: number; demoToken?: string | null; details?: { reference?: string } } } | null)?.fulfilment;
      return {
        id: purchase.id,
        amountNgn: purchase.amountNgn,
        quantity: purchase.quantity,
        unit: purchase.unit,
        label: requireProvider(purchase.providerId).resolveProduct(purchase.kind === "data" ? { productCode: purchase.productCode } : { amountNgn: purchase.amountNgn }).label,
        at: purchase.simTime.toISOString(),
        balanceBefore: f?.balanceBefore ?? null,
        balanceAfter: f?.balanceAfter ?? null,
        demoToken: f?.demoToken ?? null,
        reference: f?.details?.reference ?? null,
      };
    });

    out.push({
      kind: account.kind,
      accountId: account.id,
      label: account.label,
      identifier: account.identifier,
      network: account.network,
      providerName: provider.name,
      providerAvailable: provider.available,
      balance: balance.balance,
      unit: balance.unit,
      usageMultiplier: balance.usageMultiplier,
      activeBundle: balance.activeBundle,
      expiresAt: balance.expiresAt?.toISOString() ?? null,
      forecast: forecastView(f),
      usedLast24h: Math.round(samples.filter((x) => x.delta > 0).reduce((t, x) => t + x.delta, 0) * 100) / 100,
      hourly,
      lastPurchase: history[0] ?? null,
      history,
    });
  }
  return out;
}

export interface DecisionView {
  id: string;
  simTime: string;
  createdAt: string;
  trigger: string;
  outcome: string;
  headline: string;
  lines: ExplanationLine[];
  budgetImpact: { remainingBeforeNgn: number; plannedNgn: number; remainingAfterNgn: number; agentAuthorityBeforeNgn: number; agentAuthorityAfterNgn: number };
  purchases: { id: string; kind: UtilityKind; amountNgn: number; stage: string; paymentStatus: string; fulfilmentStatus: string }[];
}

export async function getDecisions(householdId: string, limit = 20): Promise<DecisionView[]> {
  const database = db();
  const rows = await database.select().from(s.agentDecisions).where(eq(s.agentDecisions.householdId, householdId)).orderBy(desc(s.agentDecisions.createdAt)).limit(limit);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const events = await database.select().from(s.activityEvents).where(and(inArray(s.activityEvents.decisionId, ids), eq(s.activityEvents.category, "decision")));
  const purchases = await database.select().from(s.purchases).where(inArray(s.purchases.decisionId, ids));
  return rows.map((r) => {
    const ev = events.find((e) => e.decisionId === r.id && e.type.startsWith("decision."));
    const data = (ev?.data ?? {}) as { lines?: ExplanationLine[] };
    return {
      id: r.id,
      simTime: r.simTime.toISOString(),
      createdAt: r.createdAt.toISOString(),
      trigger: r.trigger,
      outcome: r.outcome,
      headline: ev?.title ?? "Assessment",
      lines: data.lines ?? [{ kind: "decision", utility: null, text: r.reasoning }],
      budgetImpact: r.budgetImpact as DecisionView["budgetImpact"],
      purchases: purchases
        .filter((p) => p.decisionId === r.id)
        .map((p) => ({ id: p.id, kind: p.kind, amountNgn: p.amountNgn, stage: p.stage, paymentStatus: p.paymentStatus, fulfilmentStatus: p.fulfilmentStatus })),
    };
  });
}

export interface EventView {
  id: string;
  category: string;
  type: string;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  detail: string | null;
  purchaseId: string | null;
  decisionId: string | null;
  simTime: string;
  createdAt: string;
  explorerUrl: string | null;
}

export async function getEvents(householdId: string, opts: { limit?: number; purchaseId?: string; sinceMs?: number } = {}): Promise<EventView[]> {
  const conds = [eq(s.activityEvents.householdId, householdId)];
  if (opts.purchaseId) conds.push(eq(s.activityEvents.purchaseId, opts.purchaseId));
  if (opts.sinceMs) conds.push(gt(s.activityEvents.createdAt, new Date(opts.sinceMs)));
  const rows = await db()
    .select()
    .from(s.activityEvents)
    .where(and(...conds))
    .orderBy(desc(s.activityEvents.createdAt), desc(s.activityEvents.id))
    .limit(opts.limit ?? 60);
  return rows.map((e) => ({
    id: e.id,
    category: e.category,
    type: e.type,
    severity: e.severity,
    title: e.title,
    detail: e.detail,
    purchaseId: e.purchaseId,
    decisionId: e.decisionId,
    simTime: e.simTime.toISOString(),
    createdAt: e.createdAt.toISOString(),
    explorerUrl: ((e.data as { explorerUrl?: string } | null)?.explorerUrl as string | undefined) ?? null,
  }));
}

export interface PurchaseRowView {
  id: string;
  kind: UtilityKind;
  label: string;
  providerName: string;
  recipient: string;
  network: string | null;
  amountNgn: number;
  quantity: number;
  unit: string;
  stage: string;
  paymentStatus: string;
  fulfilmentStatus: string;
  initiatedBy: string;
  amountAtomic: string | null;
  asset: string;
  txHash: string | null;
  explorerUrl: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  simTime: string;
  createdAt: string;
  decisionId: string | null;
}

export async function getPurchases(householdId: string, opts: { ids?: string[]; limit?: number } = {}): Promise<PurchaseRowView[]> {
  const database = db();
  const conds = [eq(s.purchases.householdId, householdId)];
  if (opts.ids) conds.push(inArray(s.purchases.id, opts.ids));
  const rows = await database
    .select({ p: s.purchases, pay: s.payments, acc: s.utilityAccounts, prov: s.utilityProviders })
    .from(s.purchases)
    .leftJoin(s.payments, eq(s.payments.purchaseId, s.purchases.id))
    .innerJoin(s.utilityAccounts, eq(s.utilityAccounts.id, s.purchases.accountId))
    .innerJoin(s.utilityProviders, eq(s.utilityProviders.id, s.purchases.providerId))
    .where(and(...conds))
    .orderBy(desc(s.purchases.createdAt))
    .limit(opts.limit ?? 200);
  return rows.map(({ p, pay, acc, prov }) => ({
    id: p.id,
    kind: p.kind,
    label: requireProvider(p.providerId).resolveProduct(p.kind === "data" ? { productCode: p.productCode } : { amountNgn: p.amountNgn }).label,
    providerName: prov.name,
    recipient: acc.identifier,
    network: acc.network,
    amountNgn: p.amountNgn,
    quantity: p.quantity,
    unit: p.unit,
    stage: p.stage,
    paymentStatus: p.paymentStatus,
    fulfilmentStatus: p.fulfilmentStatus,
    initiatedBy: p.initiatedBy,
    amountAtomic: pay?.amountAtomic ?? null,
    asset: pay?.assetCode ?? "USDC",
    txHash: pay?.txHash ?? null,
    explorerUrl: pay?.txHash ? explorerTxUrl(pay.txHash) : null,
    failureCode: p.failureCode,
    failureMessage: p.failureMessage,
    simTime: p.simTime.toISOString(),
    createdAt: p.createdAt.toISOString(),
    decisionId: p.decisionId,
  }));
}

export async function getPurchaseDetail(householdId: string, purchaseId: string) {
  const database = db();
  const [row] = await getPurchases(householdId, { ids: [purchaseId] });
  if (!row) return null;
  const [payment] = await database.select().from(s.payments).where(eq(s.payments.purchaseId, purchaseId));
  const [receipt] = await database.select().from(s.receipts).where(eq(s.receipts.purchaseId, purchaseId));
  const events = (await getEvents(householdId, { purchaseId, limit: 100 })).reverse();
  const [decision] = row.decisionId ? await database.select().from(s.agentDecisions).where(eq(s.agentDecisions.id, row.decisionId)) : [];
  // The typed explanation lines that concern this purchase's utility (plus budget-wide lines).
  const [decisionEvent] = row.decisionId
    ? await database
        .select()
        .from(s.activityEvents)
        .where(and(eq(s.activityEvents.decisionId, row.decisionId), eq(s.activityEvents.category, "decision")))
    : [];
  const allLines = ((decisionEvent?.data as { lines?: ExplanationLine[] } | null)?.lines ?? []) as ExplanationLine[];
  const decisionLines = allLines.filter((l) => l.utility === row.kind || l.utility === null);
  return {
    decisionLines,
    purchase: row,
    payment: payment
      ? {
          status: payment.status,
          network: payment.network,
          scheme: payment.scheme,
          asset: payment.asset,
          assetCode: payment.assetCode,
          amountAtomic: payment.amountAtomic,
          payTo: payment.payTo,
          payer: payment.payer,
          txHash: payment.txHash,
          ledger: payment.ledger,
          errorCode: payment.errorCode,
          errorMessage: payment.errorMessage,
          settledAt: payment.settledAt?.toISOString() ?? null,
          confirmedAt: payment.confirmedAt?.toISOString() ?? null,
          maxTimeoutSeconds: ((payment.paymentRequired as { accepts?: { maxTimeoutSeconds?: number }[] } | null)?.accepts?.[0]?.maxTimeoutSeconds) ?? null,
        }
      : null,
    receipt: (receipt?.payload as Record<string, unknown> | undefined) ?? null,
    events,
    decisionReasoning: decision?.reasoning ?? null,
  };
}

export async function getHouseholdOverview(householdId: string) {
  const database = db();
  const state = await loadHousehold(database, householdId);
  const summary = summariseBudget(state.budget, state.policy, state.ledger);
  const simNow = state.household.simulatedNow;
  const utilities = await getUtilities(householdId, simNow);
  const [latestDecision] = await getDecisions(householdId, 1);
  const attention = await getPurchases(householdId, { limit: 50 });
  const faults = await database.select().from(s.demoFaults);
  const [scenarioEvent] = await database
    .select()
    .from(s.activityEvents)
    .where(and(eq(s.activityEvents.householdId, householdId), eq(s.activityEvents.type, "demo.scenario_loaded")))
    .orderBy(desc(s.activityEvents.createdAt))
    .limit(1);
  const scenarioId = (scenarioEvent?.data as { scenarioId?: string } | null)?.scenarioId ?? DEFAULT_SCENARIO_ID;
  return {
    scenario: { active: scenarioId, options: SCENARIOS.map((x) => ({ id: x.id, name: x.name, summary: x.summary, expect: x.expect })) },
    household: { id: state.household.id, name: state.household.name, simNow: simNow.toISOString(), currency: state.household.currency },
    budget: { ...state.budget, periodStart: state.budget.periodStart.toISOString(), periodEnd: state.budget.periodEnd.toISOString(), summary },
    policy: state.policy,
    priorities: state.priorities,
    utilities,
    latestDecision: latestDecision ?? null,
    awaitingApproval: attention.filter((p) => p.stage === "awaiting_approval"),
    needsAttention: attention.filter((p) => p.stage === "needs_attention"),
    inFlight: attention.filter((p) => ["requested", "payment_required", "submitted"].includes(p.stage)),
    providers: await providerStatus(database),
    faults: (Object.keys(DEMO_FAULTS) as DemoFaultKey[]).map((key) => ({ key, label: DEMO_FAULTS[key], enabled: faults.find((f) => f.key === key)?.enabled ?? false })),
    wallet: {
      network: env().STELLAR_NETWORK,
      agentAddress: env().AGENT_STELLAR_PUBLIC ?? null,
      asset: `${TESTNET_USDC.code} (testnet)`,
      ngnPerUsdc: env().DEMO_NGN_PER_TESTNET_USDC,
      facilitator: env().X402_FACILITATOR_URL,
    },
  };
}

export type HouseholdOverview = Awaited<ReturnType<typeof getHouseholdOverview>>;

/** Every registered provider with its live (demo) availability. */
export async function providerStatus(database = db()): Promise<{ id: string; kind: UtilityKind; name: string; available: boolean }[]> {
  const rows = await database.select().from(s.utilityProviders);
  return ALL_PROVIDERS.map((m) => ({
    id: m.definition.id,
    kind: m.definition.kind,
    name: m.definition.name,
    available: rows.find((r) => r.id === m.definition.id)?.available ?? false,
  }));
}
