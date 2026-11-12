import { z } from "zod";
import { eq } from "drizzle-orm";
import { action, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";
import { utilityProviders, UTILITY_KINDS } from "@/server/db/schema";
import { DEMO_FAULTS, setFault, type DemoFaultKey } from "@/server/demo/faults";
import { PROVIDERS } from "@/server/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.union([
  z.object({ fault: z.enum(Object.keys(DEMO_FAULTS) as [DemoFaultKey, ...DemoFaultKey[]]), enabled: z.boolean() }),
  z.object({ providerOutage: z.enum(UTILITY_KINDS), enabled: z.boolean() }),
]);

export const POST = action(async (request) => {
  const body = await parseBody(request, schema);
  if (body instanceof Response) return body;
  if ("fault" in body) {
    await setFault(body.fault, body.enabled);
  } else {
    await db().update(utilityProviders).set({ available: !body.enabled }).where(eq(utilityProviders.id, PROVIDERS[body.providerOutage].id));
  }
  return ok(body);
});
