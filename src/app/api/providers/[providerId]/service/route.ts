import { db } from "@/server/db/client";
import { handleServiceDocumentRequest } from "@/server/providers/catalog";
import { notFound, parseProviderId } from "@/server/providers/route-kind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Free: the provider's published service document. Untrusted metadata; releases nothing. */
export async function GET(_request: Request, ctx: { params: Promise<{ providerId: string }> }) {
  const provider = parseProviderId((await ctx.params).providerId);
  if (!provider) return notFound();
  return handleServiceDocumentRequest(db(), provider);
}
