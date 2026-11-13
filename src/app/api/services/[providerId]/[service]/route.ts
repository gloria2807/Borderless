import { handleServicePurchase } from "@/server/providers/service-handler";
import { errorResponse, notFound, parseProviderId } from "@/server/providers/route-kind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** x402-protected information service (e.g. a meter diagnostic). Answers HTTP 402 until paid. */
export async function POST(request: Request, ctx: { params: Promise<{ providerId: string; service: string }> }) {
  const { providerId, service } = await ctx.params;
  const provider = parseProviderId(providerId);
  if (!provider || provider.definition.category !== "intelligence") return notFound();
  try {
    return await handleServicePurchase(provider, service, request);
  } catch (err) {
    return errorResponse(err);
  }
}
