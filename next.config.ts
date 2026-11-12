import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Stellar/x402 SDKs and libsql run only on the server; keep them out of the bundler.
  serverExternalPackages: ["@libsql/client", "@stellar/stellar-sdk", "@x402/core", "@x402/stellar"],
  poweredByHeader: false,
  // Pin the workspace root (a stray lockfile in the user's home directory confuses detection).
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
