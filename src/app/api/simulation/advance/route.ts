import { z } from "zod";
import { runAgent } from "@/server/agent/run";
import { action, DEMO_HOUSEHOLD, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";
import { advanceTime, MAX_ADVANCE_HOURS } from "@/server/usage/simulator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  hours: z.number().int().min(1).max(MAX_ADVANCE_HOURS),
  /** Let Borderless re-assess after time passes (the normal monitoring loop). */
  runAgent: z.boolean().default(true),
});

export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  const database = db();
  const advanced = await advanceTime(database, DEMO_HOUSEHOLD, body.hours);
  const agent = body.runAgent ? await runAgent(database, DEMO_HOUSEHOLD, { trigger: "tick" }) : null;
  return ok({
    simNow: advanced.to.toISOString(),
    consumed: advanced.consumed,
    expiredBundles: advanced.expiredBundles,
    agent: agent ? { decisionId: agent.decisionId, outcome: agent.decision.outcome, headline: agent.explanation.headline } : null,
  });
});
