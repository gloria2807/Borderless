import { z } from "zod";
import { runAgent } from "@/server/agent/run";
import { action, DEMO_HOUSEHOLD, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({ trigger: z.enum(["manual", "tick", "scenario"]).default("manual") });

export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  const r = await runAgent(db(), DEMO_HOUSEHOLD, { trigger: body.trigger });
  return ok({
    decisionId: r.decisionId,
    outcome: r.decision.outcome,
    headline: r.explanation.headline,
    purchases: r.purchases.map((p) => ({ id: p.purchaseId, stage: p.stage, paymentStatus: p.paymentStatus, fulfilmentStatus: p.fulfilmentStatus, txHash: p.txHash, failureCode: p.failureCode })),
    awaitingApproval: r.awaitingApproval,
  });
});
