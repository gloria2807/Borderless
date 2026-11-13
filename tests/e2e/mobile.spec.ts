import { expect, test } from "@playwright/test";
import { loadScenario } from "./helpers";

test.beforeEach(async ({ request }) => loadScenario(request, "both-low"));

test("mobile: no horizontal overflow on any page", async ({ page }) => {
  for (const path of ["/", "/agent", "/household", "/accounts", "/transactions", "/settings"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});

test("mobile: top navigation and demo controls are usable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Household" }).click();
  await expect(page.getByRole("heading", { name: "Household", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open demo controls" }).click();
  await expect(page.getByRole("dialog", { name: "Demo controls" })).toBeVisible();
});
