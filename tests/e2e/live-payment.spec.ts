/**
 * The full product journey with REAL x402 payments on Stellar testnet.
 * Opt-in: E2E_LIVE=1 pnpm test:e2e  (spends ~0.06 testnet USDC per run).
 */
import { expect, test } from "@playwright/test";
import { assess, loadScenario } from "./helpers";

test.skip(!process.env.E2E_LIVE, "Set E2E_LIVE=1 to run the live testnet payment journey");

test("need → decision → x402 payment → fulfilment → updated device → receipt", async ({ page, request }) => {
  test.setTimeout(180_000);
  await loadScenario(request, "both-low");
  await page.goto("/overview");
  await assess(page);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Powered and connected");
  await expect(page.getByText(/HTTP 402/).first()).toBeVisible();

  await page.goto("/transactions");
  const rows = page.getByRole("row").filter({ hasText: /electricity|GB/ });
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.getByText("Payment confirmed")).toBeVisible();
    await expect(row.getByText("Utility released")).toBeVisible();
    await expect(row.getByRole("link", { name: /…/ })).toHaveAttribute("href", /stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/);
  }

  await rows.first().getByRole("link").first().click();
  await expect(page.getByText("Utility fulfilment confirmed")).toBeVisible();
  await expect(page.getByText("The payment was successfully settled on Stellar testnet and verified on Horizon.")).toBeVisible();

  await page.goto("/household");
  await expect(page.getByText(/Not valid on any physical meter/)).toBeVisible();
});
