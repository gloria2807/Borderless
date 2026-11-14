/**
 * The product brief's owner controls and demo actions, through the real UI and API.
 * No funds are spent: Simulate low balance runs while Borderless is paused (the meter still
 * drops, no run starts), and Scenario C is refused by the wallet's rules before signing.
 */
import { expect, test } from "@playwright/test";
import { loadScenario } from "./helpers";

test("pause, simulate a low balance (nothing starts), resume", async ({ page, request }) => {
  await loadScenario(request, "primary-electricity");
  await page.goto("/settings");
  await page.getByRole("button", { name: "Pause Borderless" }).click();
  await expect(page.getByText(/Borderless is paused by you/)).toBeVisible();

  // The demo action is real backend work: the persisted meter drops; a paused agent doesn't run.
  const res = await request.post("/api/demo/low-balance", { data: { kind: "electricity" } });
  const body = await res.json();
  expect(body.runId).toBeNull();
  expect(body.runNotStarted.code).toBe("agent_paused");
  expect(body.balanceAfter).toBeLessThan(body.balanceBefore);

  await page.goto("/overview");
  await expect(page.getByText(/Paused by you/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Simulate low balance" })).toBeDisabled();
  await expect(page.getByText(String(body.balanceAfter), { exact: false }).first()).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Resume Borderless" }).click();
  await expect(page.getByText(/Borderless is active/)).toBeVisible();
});

test("emergency stop asks for confirmation, then revokes purchasing", async ({ page, request }) => {
  await loadScenario(request, "primary-electricity");
  await page.goto("/settings");
  await page.getByRole("button", { name: "Emergency stop" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop everything" }).click();
  await expect(page.getByText(/Borderless is paused by you/)).toBeVisible();
  const state = await (await request.get("/api/agent/control")).json();
  expect(state).toMatchObject({ paused: true, autoPurchaseEnabled: false });
  await request.post("/api/agent/control", { data: { action: "resume" } });
});

test("Scenario C: an instructed over-limit purchase is refused before signing", async ({ page, request }) => {
  await loadScenario(request, "policy-rejection");
  await page.goto("/overview");
  await page.getByRole("button", { name: "Demo controls" }).first().click();
  await page.getByRole("dialog", { name: "Demo controls" }).getByRole("button", { name: "Attempt over-limit purchase" }).click();
  await expect(page).toHaveURL(/\/agent\/runs\/run_[0-9a-z]+$/, { timeout: 20_000 });
  await expect(page.getByText(/refused the purchase before anything was signed/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/per-request maximum/).first()).toBeVisible();
  // No purchase, so nothing to sign or settle.
  await page.goto("/transactions");
  await expect(page.getByText("No transactions yet")).toBeVisible();
});

test("Settings shows the persona's limits in USDC and the provider allowlist with eligibility", async ({ page, request }) => {
  await loadScenario(request, "primary-electricity");
  await page.goto("/settings");
  for (const [label, value] of [
    ["Automatic purchases, up to (per request)", "2.00"],
    ["Largest single request, even with approval", "4.00"],
    ["Each agent task, up to", "4.00"],
    ["Each day, up to", "10.00"],
  ] as const) {
    await expect(page.getByLabel(label)).toHaveValue(value);
  }
  await expect(page.getByText(/Authorised vendor for Demo Eko DisCo/).first()).toBeVisible();
});
