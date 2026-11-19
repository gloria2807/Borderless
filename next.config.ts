import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Stellar/x402 SDKs and libsql run only on the server; keep them out of the bundler.
  serverExternalPackages: ["@libsql/client", "@stellar/stellar-sdk", "@x402/core", "@x402/stellar"],
  poweredByHeader: false,
  // E2E builds use their own output folder so they never clobber a running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Pin the workspace root (a stray lockfile in the user's home directory confuses detection).
  turbopack: { root: import.meta.dirname },
  // Reset demo applies migrations at runtime: ship the SQL files with that function on serverless hosts.
  outputFileTracingIncludes: { "/api/demo/reset": ["./drizzle/**/*"] },
};

export default nextConfig;
