import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { AgentPausedError, AgentRunConflictError, AiUnavailableError, startAgentRun } from "@/server/agent/runtime/executor";
import { action, DEMO_HOUSEHOLD, fail, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";
import { agentRuns } from "@/server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  task: z.string().trim().max(600).optional(),
  mode: z.enum(["ai", "deterministic"]).optional(),
});

/** Start an agent run. Returns immediately; the run continues in the background. */
export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  try {
    const { runId } = await startAgentRun(db(), { householdId: DEMO_HOUSEHOLD, task: body.task || undefined, mode: body.mode, trigger: "manual" });
    return ok({ runId }, 202);
  } catch (err) {
    if (err instanceof AgentRunConflictError) return fail(409, err.code, err.message, { runId: err.runId });
    if (err instanceof AiUnavailableError) return fail(503, err.code, err.message);
    if (err instanceof AgentPausedError) return fail(409, err.code, err.message);
    throw err;
  }
});

/** Recent runs, newest first. */
export async function GET() {
  const rows = await db().select().from(agentRuns).where(eq(agentRuns.householdId, DEMO_HOUSEHOLD)).orderBy(desc(agentRuns.startedAt)).limit(20);
  return ok({ runs: rows });
}
