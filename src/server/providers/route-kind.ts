import { providerById } from "./registry";
import type { ProviderModule } from "./types";

/** Resolve a provider id from the URL to its provider instance (null = no such provider). */
export function parseProviderId(value: string): ProviderModule | null {
  return providerById(value) ?? null;
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
