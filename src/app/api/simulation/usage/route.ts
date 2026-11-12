import { z } from "zod";
import { action, DEMO_HOUSEHOLD, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";
import { UTILITY_KINDS } from "@/server/db/schema";
import { setUsageMultiplier } from "@/server/usage/simulator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ kind: z.enum(UTILITY_KINDS), multiplier: z.number().min(0).max(10) });

export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  await setUsageMultiplier(db(), DEMO_HOUSEHOLD, body.kind, body.multiplier);
  return ok({ kind: body.kind, multiplier: body.multiplier });
});
