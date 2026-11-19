/**
 * Agent run records and the append-only run event log.
 *
 * Every event is written to the database BEFORE it is broadcast, so what the UI shows
 * is always something the backend actually recorded — never a front-end animation.
 */
import { EventEmitter } from "node:events";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
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

/**
 * In-process broadcast of persisted events. A Server-Sent Events stream on the same server
 * gets events instantly from here; streams on other server instances (serverless hosts)
 * read them from the database instead.
 */
const globalBus = globalThis as unknown as { __borderlessRunBus?: EventEmitter };
export const runBus = (globalBus.__borderlessRunBus ??= (() => {
  const e = new EventEmitter();
  e.setMaxListeners(100);
  return e;
})());

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
  input: { householdId: string; mode: "ai" | "deterministic"; model: string | null; task: string; trigger: "manual" | "tick" | "scenario" | "low_balance"; simTime: Date },
): Promise<string> {
  const id = newId("run");
  const now = new Date();
  await db.insert(s.agentRuns).values({ id, ...input, status: "running", startedAt: now, heartbeatAt: now });
  return id;
}

/** Record that a worker is still executing this run (read by stale-run detection on any instance). */
export async function touchRunHeartbeat(db: Database, runId: string): Promise<void> {
  await db.update(s.agentRuns).set({ heartbeatAt: new Date() }).where(and(eq(s.agentRuns.id, runId), eq(s.agentRuns.status, "running")));
}

export async function appendRunEvent(db: Database, runId: string, e: RunEventInput): Promise<RunEventRow> {
  // The sequence number is assigned by the database inside the insert (one atomic statement),
  // not by a per-process counter: an approval on another server instance may append to the
  // same run. The unique (run, seq) index guarantees no duplicates; a rare clash is retried.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await insertRunEvent(db, runId, e);
    } catch (err) {
      const text = `${(err as Error)?.message ?? err} ${String((err as { cause?: unknown })?.cause ?? "")}`;
      if (attempt >= 4 || !/UNIQUE/i.test(text)) throw err;
    }
  }
}

async function insertRunEvent(db: Database, runId: string, e: RunEventInput): Promise<RunEventRow> {
  const seq = sql`(select coalesce(max(${s.agentRunEvents.seq}), 0) + 1 from ${s.agentRunEvents} where ${s.agentRunEvents.runId} = ${runId})`;
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
export async function markOrphanedRunsInterrupted(db: Database, householdId: string, liveRunIds: Set<string>, opts: { quietForMs?: number } = {}): Promise<number> {
  const running = await db
    .select({ id: s.agentRuns.id })
    .from(s.agentRuns)
    .where(and(eq(s.agentRuns.householdId, householdId), inArray(s.agentRuns.status, ["running"])));
  let orphans = running.filter((r) => !liveRunIds.has(r.id));
  if (opts.quietForMs) {
    // Only runs that have also gone silent (no event and no heartbeat): a run with recent
    // activity belongs to another worker or server instance, or is still starting up.
    const cutoff = Date.now() - opts.quietForMs;
    const quiet: typeof orphans = [];
    for (const r of orphans) {
      const [last] = await db.select({ at: s.agentRunEvents.at }).from(s.agentRunEvents).where(eq(s.agentRunEvents.runId, r.id)).orderBy(desc(s.agentRunEvents.seq)).limit(1);
      const [run] = await db.select({ startedAt: s.agentRuns.startedAt, heartbeatAt: s.agentRuns.heartbeatAt }).from(s.agentRuns).where(eq(s.agentRuns.id, r.id));
      const lastActivity = Math.max(last?.at.getTime() ?? 0, run?.startedAt.getTime() ?? 0, run?.heartbeatAt?.getTime() ?? 0);
      if (lastActivity < cutoff) quiet.push(r);
    }
    orphans = quiet;
  }
  for (const r of orphans) {
    await appendRunEvent(db, r.id, { stage: "finished", type: "run.interrupted", reason: "The server restarted while this run was in progress. Any purchase it started is reconciled separately." });
    await finishRun(db, r.id, { status: "interrupted", error: "Interrupted by a server restart." });
  }
  return orphans.length;
}
