import { z } from "zod";
import { action, DEMO_HOUSEHOLD, fail, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";
import { FundingGuardError, fundingGuardStatus, grantAllowance, revokeAllowance } from "@/server/payments/funding-guard";
import { recordEvent } from "@/server/transactions/events";
import { households } from "@/server/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.union([
  z.object({ action: z.literal("grant"), amountUsdc: z.number().min(0.01).max(10), days: z.number().int().min(1).max(30) }),
  z.object({ action: z.literal("revoke") }),
]);

/** Current on-chain state of the Funding guard (read-only). */
export async function GET() {
  return ok(await fundingGuardStatus(db(), DEMO_HOUSEHOLD));
}

/**
 * Grant or revoke the treasury's allowance to the agent wallet. Demo: the treasury key is
 * held server-side; in a real deployment the owner would sign this in their own wallet.
 */
export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  const database = db();
  const [hh] = await database.select({ simNow: households.simulatedNow }).from(households).where(eq(households.id, DEMO_HOUSEHOLD));
  try {
    if (body.action === "grant") {
      const cap = BigInt(Math.round(body.amountUsdc * 1e7));
      const r = await grantAllowance(database, DEMO_HOUSEHOLD, cap, body.days);
      await recordEvent(database, {
        householdId: DEMO_HOUSEHOLD,
        category: "system",
        type: "funding_guard.granted",
        severity: "info",
        title: "Funding guard allowance granted",
        detail: `The treasury allows the agent wallet to draw up to ${body.amountUsdc} test USDC for ${body.days} day${body.days === 1 ? "" : "s"}, enforced by Stellar.`,
        data: { txHash: r.txHash, expirationLedger: r.expirationLedger },
        simTime: hh?.simNow ?? new Date(),
      });
      return ok(r);
    }
    const r = await revokeAllowance(database, DEMO_HOUSEHOLD);
    await recordEvent(database, {
      householdId: DEMO_HOUSEHOLD,
      category: "system",
      type: "funding_guard.revoked",
      severity: "info",
      title: "Funding guard allowance revoked",
      detail: "The agent wallet can no longer draw from the treasury.",
      data: { txHash: r.txHash },
      simTime: hh?.simNow ?? new Date(),
    });
    return ok(r);
  } catch (err) {
    if (err instanceof FundingGuardError) return fail(err.code === "not_configured" ? 503 : 422, err.code, err.message);
    throw err;
  }
});
