import { handleRegistryRequest } from "@/server/providers/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Free: the curated provider registry (who exists, and where each publishes its service document). */
export function GET() {
  return handleRegistryRequest();
}
