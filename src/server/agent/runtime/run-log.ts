/**
 * Agent run records and the append-only run event log.
 *
 * Every event is written to the database BEFORE it is broadcast, so what the UI shows
 * is always something the backend actually recorded — never a front-end animation.
 */
import { EventEmitter } from "node:events";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Database } from "../../db/client";
import * as s from "../../db/schema";
import type { RunStage, UtilityKind } from "../../db/schema";
import { newId } from "../../lib/ids";

export type RunEventRow = typeof s.agentRunEvents.$inferSelect;

export interface RunEventInput {
  stage: RunStage;
  type: string;
  utility?: UtilityKind | null;
  tool?: string | null;
  input?: unknown;
  result?: unknown;
  decision?: string | null;
  reason?: string | null;
  paymentStatus?: string | null;
  txHash?: string | null;
  purchaseId?: string | null;
  error?: string | null;
}

/** In-process broadcast of persisted events (Server-Sent Events subscribe here). */
const globalBus = globalThis as unknown as { __borderlessRunBus?: EventEmitter };
export const runBus = (globalBus.__borderlessRunBus ??= (() => {
  const e = new EventEmitter();
  e.setMaxListeners(100);
  return e;
})());

const seqCounters = new Map<string, number>();

/** JSON-safe copy (Infinity/NaN → null, bigint → string, Dates → ISO). */
export function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "number" && !Number.isFinite(v)) return null;
      return v;
    }),
  );
}

export async function createRun(
  db: Database,
  input: { householdId: string; mode: "ai" | "deterministic"; model: string | null; task: string; trigger: "manual" | "tick" | "scenario"; simTime: Date },
): Promise<string> {
  const id = newId("run");
  await db.insert(s.agentRuns).values({ id, ...input, status: "running", startedAt: new Date() });
  seqCounters.set(id, 0);
  return id;
}

export async function appendRunEvent(db: Database, runId: string, e: RunEventInput): Promise<RunEventRow> {
  let seq = seqCounters.get(runId);
  if (seq === undefined) {
    const rows = await db.select({ seq: s.agentRunEvents.seq }).from(s.agentRunEvents).where(eq(s.agentRunEvents.runId, runId));
    seq = rows.reduce((m, r) => Math.max(m, r.seq), 0);
  }
  seq += 1;
  seqCounters.set(runId, seq);
  const [row] = await db
    .insert(s.agentRunEvents)
    .values({
      id: newId("rev"),
      runId,
      seq,
      at: new Date(),
      stage: e.stage,
      type: e.type,
      utility: e.utility ?? null,
      tool: e.tool ?? null,
      input: e.input === undefined ? null : jsonSafe(e.input),
      result: e.result === undefined ? null : jsonSafe(e.result),
      decision: e.decision ?? null,
      reason: e.reason ?? null,
      paymentStatus: e.paymentStatus ?? null,
      txHash: e.txHash ?? null,
      purchaseId: e.purchaseId ?? null,
      error: e.error ?? null,
    })
    .returning();
  runBus.emit(`run:${runId}`, row);
  return row!;
}

export async function finishRun(
  db: Database,
  runId: string,
  patch: { status: "completed" | "failed" | "interrupted"; summary?: string | null; error?: string | null; steps?: number; usage?: unknown },
): Promise<void> {
  await db
    .update(s.agentRuns)
    .set({ status: patch.status, summary: patch.summary ?? null, error: patch.error ?? null, steps: patch.steps ?? 0, usage: patch.usage === undefined ? null : jsonSafe(patch.usage), endedAt: new Date() })
    .where(eq(s.agentRuns.id, runId));
  seqCounters.delete(runId);
  runBus.emit(`run:${runId}:end`, { runId, status: patch.status });
}

export async function listRunEvents(db: Database, runId: string, afterSeq = 0): Promise<RunEventRow[]> {
  return db
    .select()
    .from(s.agentRunEvents)
    .where(and(eq(s.agentRunEvents.runId, runId), gt(s.agentRunEvents.seq, afterSeq)))
    .orderBy(s.agentRunEvents.seq);
}

/**
 * Runs left "running" by a previous process (crash / restart) can never finish: mark them
 * interrupted. Their purchases are reconciled separately by the purchase sweep.
 */
export async function markOrphanedRunsInterrupted(db: Database, householdId: string, liveRunIds: Set<string>): Promise<number> {
  const running = await db
    .select({ id: s.agentRuns.id })
    .from(s.agentRuns)
    .where(and(eq(s.agentRuns.householdId, householdId), inArray(s.agentRuns.status, ["running"])));
  const orphans = running.filter((r) => !liveRunIds.has(r.id));
  for (const r of orphans) {
    await appendRunEvent(db, r.id, { stage: "finished", type: "run.interrupted", reason: "The server restarted while this run was in progress. Any purchase it started is reconciled separately." });
    await finishRun(db, r.id, { status: "interrupted", error: "Interrupted by a server restart." });
  }
  return orphans.length;
}
