import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Stellar/x402 SDKs and libsql run only on the server; keep them out of the bundler.
  serverExternalPackages: ["@libsql/client", "@stellar/stellar-sdk", "@x402/core", "@x402/stellar"],
  poweredByHeader: false,
};

export default nextConfig;
