import { eq } from "drizzle-orm";
import { action, DEMO_HOUSEHOLD, fail, ok } from "@/server/api";
import { db } from "@/server/db/client";
import { purchases } from "@/server/db/schema";
import { executePurchase, recoverPurchase } from "@/server/payments/x402-buyer";
import { approvePurchase, declinePurchase } from "@/server/transactions/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = action(async (_request, ctx) => {
  const { id, action: verb } = await ctx.params;
  if (!id || !/^pur_[0-9a-z]+$/.test(id)) return fail(400, "invalid_id", "Invalid purchase id.");
  const database = db();
  const [p] = await database.select().from(purchases).where(eq(purchases.id, id));
  if (!p || p.householdId !== DEMO_HOUSEHOLD) return fail(404, "not_found", "Purchase not found.");

  switch (verb) {
    case "approve":
      await approvePurchase(database, id);
      return ok(await executePurchase(database, id));
    case "decline":
      await declinePurchase(database, id);
      return ok({ id, stage: "cancelled" });
    case "recover":
      // Never pays again: re-requests fulfilment / reconciles the existing payment only.
      return ok(await recoverPurchase(database, id));
    default:
      return fail(404, "unknown_action", "Unknown action.");
  }
});
