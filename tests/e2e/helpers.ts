import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** Reset the isolated e2e household to a scenario through the app's own API. */
export async function loadScenario(request: APIRequestContext, scenario: string) {
  const res = await request.post("/api/demo/reset", { data: { scenario } });
  expect(res.ok()).toBeTruthy();
}

/**
 * Click "Assess household now" and wait for the agent run to finish. Waits on the API
 * response itself — the button's label changes while running, so waiting on the
 * button would match the other "Assess" button on the page and return too early.
 */
export async function assess(page: Page) {
  const done = page.waitForResponse((r) => r.url().endsWith("/api/agent/run") && r.request().method() === "POST", { timeout: 150_000 });
  await page.getByRole("button", { name: "Assess household now" }).first().click();
  const res = await done;
  expect(res.status(), await res.text()).toBeLessThan(500);
  // Let the post-action refresh render the persisted result.
  await page.waitForLoadState("networkidle");
}
