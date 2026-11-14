import { z } from "zod";
import { agentControlState, controlAgent } from "@/server/agent/control";
import { action, DEMO_HOUSEHOLD, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ action: z.enum(["pause", "resume", "emergency_stop"]) }).strict();

/** Owner-only controls: pause, resume, emergency stop. No agent tool can reach this route. */
export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  return ok(await controlAgent(db(), DEMO_HOUSEHOLD, body.action));
});

export async function GET() {
  return ok(await agentControlState(db(), DEMO_HOUSEHOLD));
}
