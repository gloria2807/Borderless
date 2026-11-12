import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a production build on port 3100 with an isolated
 * database (data/e2e.db), so they never touch the demo household.
 *
 * By default no test spends testnet funds. Set E2E_LIVE=1 to include the live
 * x402 payment journey (requires funded wallets from `pnpm wallets:setup`).
 */
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1, // tests share one household database
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: BASE, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } }, testIgnore: /mobile.spec.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: "pnpm exec tsx scripts/db-reset.ts && pnpm exec next build && pnpm exec next start -p 3100",
    url: BASE,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: "file:./data/e2e.db",
      APP_BASE_URL: BASE,
      PORT: String(PORT),
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
});
