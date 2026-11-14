import { z } from "zod";
import { action, DEMO_HOUSEHOLD, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";
import { simulateLowBalance } from "@/server/demo/low-balance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .object({
    kind: z.enum(["electricity", "airtime", "data"]).default("electricity"),
    mode: z.enum(["ai", "deterministic"]).default("deterministic"),
  })
  .strict();

/**
 * Demo control: lower the simulated balance (persisted), record it, and start a real agent run.
 * Payments in that run are genuine Stellar testnet x402 payments.
 */
export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  const r = await simulateLowBalance(db(), DEMO_HOUSEHOLD, { kind: body.kind, mode: body.mode });
  return ok(r, r.runId ? 202 : 200);
});
