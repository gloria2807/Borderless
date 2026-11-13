import { eq } from "drizzle-orm";
import { reconcileOrphanedRuns } from "@/server/agent/runtime/executor";
import { listRunEvents, runBus, type RunEventRow } from "@/server/agent/runtime/run-log";
import { DEMO_HOUSEHOLD, fail } from "@/server/api";
import { db } from "@/server/db/client";
import { agentRuns } from "@/server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * Server-Sent Events for one agent run.
 *
 * Every event sent here was persisted first (run-log writes, then broadcasts). On
 * connect, the stream replays the persisted log after `Last-Event-ID` (or `?after=`),
 * then forwards live events, so a refresh or reconnect never loses or duplicates one.
 * The stream ends with an `end` event once the run is no longer running.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^run_[0-9a-z]+$/.test(id)) return fail(400, "invalid_id", "Invalid run id.");
  const database = db();
  // A run cut off by a restart is closed first, so the stream ends instead of hanging.
  await reconcileOrphanedRuns(database, DEMO_HOUSEHOLD);
  const [run] = await database.select().from(agentRuns).where(eq(agentRuns.id, id));
  if (!run || run.householdId !== DEMO_HOUSEHOLD) return fail(404, "not_found", "Run not found.");

  const url = new URL(request.url);
  const resumeFrom = Number(request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0);
  let lastSeq = Number.isFinite(resumeFrom) && resumeFrom > 0 ? Math.floor(resumeFrom) : 0;

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      const sendEvent = (row: RunEventRow) => {
        if (row.seq <= lastSeq) return; // already sent (replay/live overlap)
        lastSeq = row.seq;
        write(`id: ${row.seq}\nevent: run-event\ndata: ${JSON.stringify(row)}\n\n`);
      };
      const sendEnd = async () => {
        const [r] = await database.select().from(agentRuns).where(eq(agentRuns.id, id));
        write(`event: end\ndata: ${JSON.stringify({ runId: id, status: r?.status ?? "unknown" })}\n\n`);
        close();
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Subscribe BEFORE replaying, buffering live events until the replay is sent.
      const buffered: RunEventRow[] = [];
      let replaying = true;
      const onEvent = (row: RunEventRow) => (replaying ? buffered.push(row) : sendEvent(row));
      const onEnd = () => {
        // Let any events persisted just before the end flush first.
        void listRunEvents(database, id, lastSeq).then((rows) => {
          rows.forEach(sendEvent);
          return sendEnd();
        });
      };
      runBus.on(`run:${id}`, onEvent);
      runBus.once(`run:${id}:end`, onEnd);
      const heartbeat = setInterval(() => write(`: keep-alive\n\n`), HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        runBus.off(`run:${id}`, onEvent);
        runBus.off(`run:${id}:end`, onEnd);
      };
      request.signal.addEventListener("abort", close);

      write(`retry: 2000\n\n`);
      for (const row of await listRunEvents(database, id, lastSeq)) sendEvent(row);
      replaying = false;
      buffered.sort((a, b) => a.seq - b.seq).forEach(sendEvent);

      const [now] = await database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, id));
      if (now?.status !== "running") await sendEnd();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
