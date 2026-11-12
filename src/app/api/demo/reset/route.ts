import { z } from "zod";
import { action, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { SCENARIOS } from "@/server/demo/scenarios";
import { resetDemo } from "@/server/household/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ scenario: z.enum(SCENARIOS.map((s) => s.id) as [string, ...string[]]).optional() });

/** Resets the SIMULATED household. On-chain testnet transactions are permanent and unaffected. */
export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  const database = db();
  await runMigrations(database);
  const scenario = await resetDemo(database, body.scenario);
  return ok({ reset: true, scenario: { id: scenario.id, name: scenario.name, expect: scenario.expect } });
});
