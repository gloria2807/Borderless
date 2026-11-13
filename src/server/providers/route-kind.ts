import type { UtilityKind } from "../db/schema";
import { providerById } from "./registry";

/** Resolve a provider id from the URL to the utility it serves (null = no such provider). */
export function parseProviderId(value: string): UtilityKind | null {
  return providerById(value)?.definition.kind ?? null;
}

export const notFound = () =>
  new Response(JSON.stringify({ code: "unknown_provider", message: "No such provider." }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

export function errorResponse(err: unknown): Response {
  const code = (err as { code?: string }).code ?? "provider_error";
  const message = err instanceof Error ? err.message : "Unexpected provider error";
  console.error("[provider]", code, message);
  return new Response(JSON.stringify({ code, message }), {
    status: code === "configuration_error" ? 503 : 500,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
