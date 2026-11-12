import { action, DEMO_HOUSEHOLD, ok, parseBody } from "@/server/api";
import { db } from "@/server/db/client";
import { settingsSchema, updateSettings } from "@/server/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = action(async (request) => {
  const body = await parseBody(request, settingsSchema);
  if (body instanceof Response) return body;
  await updateSettings(db(), DEMO_HOUSEHOLD, body);
  return ok({ saved: true });
});
