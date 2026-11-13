import { eq } from "drizzle-orm";
import { action, DEMO_HOUSEHOLD, fail, ok } from "@/server/api";
import { db } from "@/server/db/client";
import { purchases } from "@/server/db/schema";
import { executePurchase, recoverPurchase } from "@/server/payments/x402-buyer";
import { approvePurchase, declinePurchase } from "@/server/transactions/approvals";
import { probeUnpaid } from "@/server/transactions/probe";
import { appendRunEvent } from "@/server/agent/runtime/run-log";
import { payAndLog } from "@/server/agent/runtime/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = action(async (request, ctx) => {
  const { id, action: verb } = await ctx.params;
  if (!id || !/^pur_[0-9a-z]+$/.test(id)) return fail(400, "invalid_id", "Invalid purchase id.");
  const database = db();
  const [p] = await database.select().from(purchases).where(eq(purchases.id, id));
  if (!p || p.householdId !== DEMO_HOUSEHOLD) return fail(404, "not_found", "Purchase not found.");

  switch (verb) {
    case "approve":
      {
        const body = (await request.json().catch(() => ({}))) as { termsHash?: unknown };
        const termsHash = typeof body.termsHash === "string" && /^[0-9a-f]{64}$/.test(body.termsHash) ? body.termsHash : undefined;
        await approvePurchase(database, id, { termsHash });
      }
      if (p.runId) {
        await appendRunEvent(database, p.runId, { stage: "awaiting_approval", type: "approval.granted", utility: p.kind, purchaseId: id, decision: "approved", reason: "The owner approved. Paying now." });
        return ok((await payAndLog(database, p.runId, id, p.kind)).result);
      }
      return ok(await executePurchase(database, id));
    case "decline":
      await declinePurchase(database, id);
      return ok({ id, stage: "cancelled" });
    case "recover":
      // Never pays again: re-requests fulfilment / reconciles the existing payment only.
      return ok(await recoverPurchase(database, id));
    case "probe-unpaid":
      // The same request the agent made, without paying: shows the provider's real HTTP 402.
      return ok(await probeUnpaid(database, id));
    default:
      return fail(404, "unknown_action", "Unknown action.");
  }
});
