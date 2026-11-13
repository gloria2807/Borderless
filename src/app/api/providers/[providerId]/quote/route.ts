import { handleQuoteRequest } from "@/server/providers/quote-handler";
import { errorResponse, notFound, parseProviderId } from "@/server/providers/route-kind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Free: issue a short-lived quote. Purchases must redeem one. */
export async function POST(request: Request, ctx: { params: Promise<{ providerId: string }> }) {
  const kind = parseProviderId((await ctx.params).providerId);
  if (!kind) return notFound();
  try {
    return await handleQuoteRequest(kind, request);
  } catch (err) {
    return errorResponse(err);
  }
}
