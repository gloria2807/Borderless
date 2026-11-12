import { handleFulfilmentRetry } from "@/server/providers/purchase-handler";
import { errorResponse, notFound, parseKind } from "@/server/providers/route-kind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ kind: string }> }) {
  const kind = parseKind((await ctx.params).kind);
  if (!kind) return notFound();
  try {
    return await handleFulfilmentRetry(kind, request);
  } catch (err) {
    return errorResponse(err);
  }
}
