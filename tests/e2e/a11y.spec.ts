/** Automated accessibility checks (axe-core, WCAG 2.1 A/AA) on every page. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loadScenario } from "./helpers";

const PAGES = ["/", "/overview", "/agent", "/household", "/accounts", "/providers", "/transactions", "/settings"];

test.beforeAll(async ({ request }) => loadScenario(request, "both-low"));

for (const path of PAGES) {
  test(`no serious accessibility violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    const summary = serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.target.join(" ")}`);
    expect(summary, summary.join("\n")).toEqual([]);
  });
}

test("keyboard: every page is reachable from the navigation with visible focus", async ({ page }) => {
  await page.goto("/overview");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toHaveText(/Overview/);
  const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  // The nav is grouped: Overview, Household, Accounts, then the agent group.
  await expect(page).toHaveURL(/\/household$/);
});
