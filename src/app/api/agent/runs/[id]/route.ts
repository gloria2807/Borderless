import { eq } from "drizzle-orm";
import { listRunEvents } from "@/server/agent/runtime/run-log";
import { DEMO_HOUSEHOLD, fail, ok } from "@/server/api";
import { db } from "@/server/db/client";
import { agentRuns } from "@/server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A run and its full, ordered event log (persisted; survives refresh and restart). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^run_[0-9a-z]+$/.test(id)) return fail(400, "invalid_id", "Invalid run id.");
  const [run] = await db().select().from(agentRuns).where(eq(agentRuns.id, id));
  if (!run || run.householdId !== DEMO_HOUSEHOLD) return fail(404, "not_found", "Run not found.");
  return ok({ run, events: await listRunEvents(db(), id) });
}
