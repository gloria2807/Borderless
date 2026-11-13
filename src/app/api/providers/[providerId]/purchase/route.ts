import { handleProviderPurchase } from "@/server/providers/purchase-handler";
import { errorResponse, notFound, parseProviderId } from "@/server/providers/route-kind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** x402-protected purchase. The order must redeem a quote from this provider. */
export async function POST(request: Request, ctx: { params: Promise<{ providerId: string }> }) {
  const provider = parseProviderId((await ctx.params).providerId);
  if (!provider) return notFound();
  try {
    return await handleProviderPurchase(provider, request);
  } catch (err) {
    return errorResponse(err);
  }
}
