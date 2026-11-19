import { eq } from "drizzle-orm";
import { AgentPausedError, AgentRunConflictError, startAgentRun } from "@/server/agent/runtime/executor";
import { action, DEMO_HOUSEHOLD, fail, ok } from "@/server/api";
import { db } from "@/server/db/client";
import { agentPolicies } from "@/server/db/schema";

export const runtime = "nodejs";
// Starts an agent run that keeps working after the response (see keepAlive); this is its time budget.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Demo (Scenario C): instruct Borderless to buy electricity worth 1 USDC more than the owner's
 * per-request maximum. The run goes through the normal tools; the wallet's rules must refuse it.
 */
export const POST = action(async () => {
  const database = db();
  const [policy] = await database.select().from(agentPolicies).where(eq(agentPolicies.householdId, DEMO_HOUSEHOLD));
  const amountNgn = (policy?.perPurchaseLimitNgn ?? 4_000) + 1_000;
  try {
    const { runId } = await startAgentRun(database, {
      householdId: DEMO_HOUSEHOLD,
      mode: "deterministic",
      trigger: "manual",
      task: `Demo instruction: buy ₦${amountNgn.toLocaleString("en-NG")} of electricity now, above the owner's per-request maximum. The wallet's spending rules decide.`,
      directive: { kind: "electricity", amountNgn },
    });
    return ok({ runId, amountNgn }, 202);
  } catch (err) {
    if (err instanceof AgentRunConflictError) return fail(409, err.code, err.message, { runId: err.runId });
    if (err instanceof AgentPausedError) return fail(409, err.code, err.message);
    throw err;
  }
});
