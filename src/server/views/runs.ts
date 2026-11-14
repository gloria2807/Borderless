/**
 * Read models for Agent Operations. Server-only, plain serialisable data built from the
 * persisted run log — the UI shows only what the backend recorded.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { aiProvider, env } from "../config/env";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { RunStage, UtilityKind } from "../db/schema";
import { aiAvailable, reconcileOrphanedRuns } from "../agent/runtime/executor";
import { DEFAULT_TASK } from "../agent/runtime/executor";
import { listRunEvents, type RunEventRow } from "../agent/runtime/run-log";
import { providerById, requireProvider } from "../providers/registry";
import { expireApprovals } from "../transactions/approvals";

/** A run event as sent to the browser (same shape the SSE stream sends). */
export type RunEventDTO = Omit<RunEventRow, "at"> & { at: string };

/** Tool names before the brief-aligned rename, so older run logs still read correctly. */
const LEGACY_TOOL_NAMES: Record<string, string> = { discover_providers: "discover_services", propose_purchase: "evaluate_purchase", purchase_utility: "buy_service" };

export const toEventDTO = (e: RunEventRow): RunEventDTO => ({ ...e, tool: e.tool ? (LEGACY_TOOL_NAMES[e.tool] ?? e.tool) : e.tool, at: e.at.toISOString() });

export interface RunSummaryView {
  id: string;
  status: "running" | "completed" | "failed" | "interrupted";
  mode: "ai" | "deterministic";
  model: string | null;
  task: string;
  trigger: string;
  startedAt: string;
  endedAt: string | null;
  simTime: string;
  summary: string | null;
  error: string | null;
  steps: number;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  purchaseCount: number;
}

export interface RunPurchaseView {
  id: string;
  kind: UtilityKind;
  label: string;
  amountNgn: number;
  providerName: string;
  stage: string;
  paymentStatus: string;
  fulfilmentStatus: string;
  failureCode: string | null;
  approvalExpiresAt: string | null;
  approvalTermsHash: string | null;
  approvalTerms: { amountAtomic: string; payTo: string; recipient: string } | null;
  txHash: string | null;
}

export interface RunView {
  run: RunSummaryView;
  events: RunEventDTO[];
  purchases: RunPurchaseView[];
  explorerTxBase: string;
}

function summary(r: typeof s.agentRuns.$inferSelect, purchaseCount: number): RunSummaryView {
  return {
    id: r.id,
    status: r.status as RunSummaryView["status"],
    mode: r.mode as RunSummaryView["mode"],
    model: r.model,
    task: r.task,
    trigger: r.trigger,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    simTime: r.simTime.toISOString(),
    summary: r.summary,
    error: r.error,
    steps: r.steps,
    usage: (r.usage as RunSummaryView["usage"]) ?? null,
    purchaseCount,
  };
}

export async function getRecentRuns(householdId: string, limit = 10): Promise<RunSummaryView[]> {
  const database = db();
  await reconcileOrphanedRuns(database, householdId);
  const rows = await database.select().from(s.agentRuns).where(eq(s.agentRuns.householdId, householdId)).orderBy(desc(s.agentRuns.startedAt)).limit(limit);
  if (!rows.length) return [];
  const ps = await database.select({ runId: s.purchases.runId }).from(s.purchases).where(inArray(s.purchases.runId, rows.map((r) => r.id)));
  return rows.map((r) => summary(r, ps.filter((p) => p.runId === r.id).length));
}

export async function getRunView(householdId: string, runId: string): Promise<RunView | null> {
  const database = db();
  // Close approval requests whose window has passed, so the card never offers a stale one.
  await expireApprovals(database, householdId);
  await reconcileOrphanedRuns(database, householdId);
  const [run] = await database.select().from(s.agentRuns).where(eq(s.agentRuns.id, runId));
  if (!run || run.householdId !== householdId) return null;
  const rows = await database
    .select({ p: s.purchases, pay: s.payments })
    .from(s.purchases)
    .leftJoin(s.payments, eq(s.payments.purchaseId, s.purchases.id))
    .where(eq(s.purchases.runId, runId))
    .orderBy(s.purchases.createdAt);
  const purchases: RunPurchaseView[] = rows.map(({ p, pay }) => ({
    id: p.id,
    kind: p.kind,
    label: requireProvider(p.providerId).resolveProduct(p.kind === "data" ? { productCode: p.productCode } : { amountNgn: p.amountNgn }).label,
    amountNgn: p.amountNgn,
    providerName: providerById(p.providerId)?.definition.name ?? p.providerId,
    stage: p.stage,
    paymentStatus: p.paymentStatus,
    fulfilmentStatus: p.fulfilmentStatus,
    failureCode: p.failureCode,
    approvalExpiresAt: p.approvalExpiresAt?.toISOString() ?? null,
    approvalTermsHash: p.approvalTermsHash,
    approvalTerms: p.approvalTerms ? { amountAtomic: p.approvalTerms.amountAtomic, payTo: p.approvalTerms.payTo, recipient: p.approvalTerms.recipient } : null,
    txHash: pay?.txHash ?? null,
  }));
  return {
    run: summary(run, purchases.length),
    events: (await listRunEvents(database, runId)).map(toEventDTO),
    purchases,
    explorerTxBase: env().STELLAR_EXPLORER_TX_URL.replace(/\/+$/, ""),
  };
}

export function launcherInfo() {
  return { aiAvailable: aiAvailable(), model: aiProvider()?.model ?? env().GEMINI_MODEL, defaultTask: DEFAULT_TASK };
}

export type { RunStage };
