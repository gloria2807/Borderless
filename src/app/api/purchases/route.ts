import { z } from "zod";
import { action, DEMO_HOUSEHOLD, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";
import { UTILITY_KINDS } from "@/server/db/schema";
import { executePurchase } from "@/server/payments/x402-buyer";
import { createPurchase } from "@/server/transactions/purchases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Owner-initiated purchase (e.g. "Buy the recommended bundle"). Same budget rules and payment path as the agent. */
const schema = z
  .object({
    kind: z.enum(UTILITY_KINDS),
    amountNgn: z.number().int().positive().optional(),
    productCode: z.string().max(64).optional(),
    idempotencyKey: z.string().min(8).max(80).optional(),
  })
  .refine((v) => (v.kind === "data" ? !!v.productCode : !!v.amountNgn), { message: "Data needs a productCode; other utilities need amountNgn" });

export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  const database = db();
  const purchase = await createPurchase(database, { householdId: DEMO_HOUSEHOLD, ...body, initiatedBy: "owner" });
  const result = await executePurchase(database, purchase.id);
  return ok(result, result.stage === "failed" ? 422 : 200);
});
