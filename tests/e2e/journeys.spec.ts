/**
 * Core user journeys. None of these spend testnet funds: every scenario here ends
 * before payment (blocked, flagged, parked for approval, or authority revoked).
 */
import { expect, test } from "@playwright/test";
import { assess, loadScenario } from "./helpers";

test.describe("overview", () => {
  test.beforeEach(async ({ request }) => loadScenario(request, "both-low"));

  test("answers the household's questions at a glance", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Mobile data will run out|running low/);
    await expect(page.getByRole("heading", { name: "Service runway" })).toBeVisible();
    for (const name of ["Electricity", "Airtime", "Mobile data"]) {
      await expect(page.getByRole("img", { name: new RegExp(`^${name}:`) })).toBeVisible();
    }
    await expect(page.getByRole("main").getByText("₦8,000").first()).toBeVisible(); // remaining budget
    await expect(page.getByText(/testnet USDC, which has no monetary value/)).toBeVisible();
  });

  test("navigation marks the current page", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" }).first();
    await nav.getByRole("link", { name: "Transactions" }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(nav.getByRole("link", { name: "Transactions" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("No transactions yet")).toBeVisible();
  });
});

test("Example D: budget exhausted, so nothing is paid", async ({ page, request }) => {
  await loadScenario(request, "budget-exhausted");
  await page.goto("/");
  await assess(page);
  await expect(page.getByRole("heading", { name: /Can't buy electricity/ })).toBeVisible();
  await expect(page.getByText(/Increase the budget or change priorities/).first()).toBeVisible();
  await page.goto("/transactions");
  await expect(page.getByText("No transactions yet")).toBeVisible();
});

test("Example C: unusual data use is flagged, not bought", async ({ page, request }) => {
  await loadScenario(request, "unusual-data");
  await page.goto("/agent");
  await assess(page);
  await expect(page.getByText("Flagged for review").first()).toBeVisible();
  await expect(page.getByRole("main").getByText(/\d\.\d× this household's usual rate/).first()).toBeVisible();
  await page.goto("/transactions");
  await expect(page.getByText("No transactions yet")).toBeVisible();
});

test("approval: a parked purchase can be declined without paying", async ({ page, request }) => {
  await loadScenario(request, "needs-approval");
  await page.goto("/");
  await assess(page);
  const prompt = page.getByText(/Borderless wants to buy .* electricity for/);
  await expect(prompt).toBeVisible();
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Purchase declined")).toBeVisible();
  await expect(prompt).toHaveCount(0);

  await page.goto("/transactions");
  const row = page.getByRole("row").filter({ hasText: "electricity" });
  await expect(row.getByText("Declined")).toBeVisible();
  await expect(row.getByText("None").first()).toBeVisible(); // no testnet payment
});

test("settings: revoking authority stops purchasing", async ({ page, request }) => {
  await loadScenario(request, "both-low");
  await page.goto("/settings");
  await page.getByRole("switch", { name: "Automatic purchasing" }).click();
  await expect(page.getByText(/Revoked\. Borderless keeps monitoring/)).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();

  await page.goto("/agent");
  await expect(page.getByText("Off, recommendations only")).toBeVisible();
  await assess(page);
  await expect(page.getByRole("main").getByText(/Automatic purchasing is off/).first()).toBeVisible();
  await page.goto("/transactions");
  await expect(page.getByText("No transactions yet")).toBeVisible();
});

test("settings: invalid limits are explained before saving", async ({ page, request }) => {
  await loadScenario(request, "both-low");
  await page.goto("/settings");
  const threshold = page.getByLabel("Ask me before purchases above");
  await threshold.fill("9000");
  await expect(page.getByText(/approval threshold is above the per-purchase limit/)).toBeVisible();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(threshold).toHaveValue("4,000");
});

test("demo controls: load a scenario from the picker", async ({ page, request }) => {
  await loadScenario(request, "both-low");
  await page.goto("/");
  await page.getByRole("button", { name: "Demo controls" }).click();
  const panel = page.getByRole("dialog", { name: "Demo controls" });
  await panel.getByRole("radio", { name: /Budget exhausted/ }).check();
  await expect(panel.getByText(/does not attempt payment/)).toBeVisible();
  await panel.getByRole("button", { name: "Load scenario" }).click();
  await page.getByRole("dialog", { name: /Load "Budget exhausted"/ }).getByRole("button", { name: "Load scenario" }).click();
  await expect(page.getByText("Loaded: Budget exhausted")).toBeVisible();
});

test("unknown transaction shows a helpful not-found page", async ({ page }) => {
  // Note: the (app) loading skeleton streams before notFound() runs, so Next.js sends a
  // "soft" 404 (HTTP 200 + not-found UI). The page content is what matters to the user.
  await page.goto("/transactions/pur_0000000000none");
  await expect(page.getByText("There's nothing at this address")).toBeVisible();
});

test("cross-site requests cannot drive the agent", async ({ request }) => {
  const res = await request.post("/api/agent/run", { data: {}, headers: { origin: "https://attacker.example" } });
  expect(res.status()).toBe(403);
});
