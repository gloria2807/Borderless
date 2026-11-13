import { handleFulfilmentRetry } from "@/server/providers/purchase-handler";
import { errorResponse, notFound, parseProviderId } from "@/server/providers/route-kind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ providerId: string }> }) {
  const provider = parseProviderId((await ctx.params).providerId);
  if (!provider) return notFound();
  try {
    return await handleFulfilmentRetry(provider, request);
  } catch (err) {
    return errorResponse(err);
  }
}
