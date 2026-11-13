/**
 * Agent Operations journeys. None of these spend testnet funds: each run ends before
 * payment (blocked by budget, or parked for approval and then declined or expired).
 * The deterministic planner is used so the journeys never depend on a paid AI model.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadScenario } from "./helpers";

async function startDeterministicRun(page: Page) {
  await page.goto("/agent");
  await page.getByText("Deterministic (no AI)").click();
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/agent\/runs\/run_[0-9a-z]+$/);
  return page.url().split("/").at(-1)!;
}

async function persistedEvents(request: APIRequestContext, runId: string) {
  const res = await request.get(`/api/agent/runs/${runId}`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { events: { seq: number; type: string }[] }).events;
}

test("operations: a run streams every persisted step and survives a refresh", async ({ page, request }) => {
  await loadScenario(request, "budget-exhausted");
  const runId = await startDeterministicRun(page);

  await expect(page.getByText("Run completed")).toBeVisible();
  await expect(page.getByRole("list", { name: "Run stages" }).getByText("Finished")).toBeVisible();
  await expect(page.locator('[aria-label="Run stages"] [aria-current="step"]')).toHaveCount(0);

  // What the page shows is exactly the backend log (tool call + result render as one step).
  const events = await persistedEvents(request, runId);
  expect(events.at(-1)?.type).toBe("run.completed");
  const rendered = await page.locator("li[data-stage]").count();
  const merged = events.filter((e) => e.type !== "tool.result").length;
  expect(rendered).toBe(merged);

  // Refresh-safe: the same history comes back from the database.
  await page.reload();
  await expect(page.locator("li[data-stage]")).toHaveCount(merged);
  await expect(page.getByText(/Can't buy electricity|isn't enough for a useful electricity purchase/).first()).toBeVisible();

  // Nothing was paid; the run appears under recent runs.
  await page.goto("/agent");
  await expect(page.getByRole("link", { name: /Open run/ }).first()).toBeVisible();
});

test("operations: expandable details show the policy evaluation", async ({ page, request }) => {
  await loadScenario(request, "needs-approval");
  await startDeterministicRun(page);
  const policy = page.locator("li[data-stage]").filter({ hasText: "Spending rules — needs approval" });
  await policy.getByText("Details").click();
  await expect(policy.getByText("Owner approval")).toBeVisible();
  await expect(policy.getByText("Household budget has room")).toBeVisible();
});

test("operations: approval card counts down and can be declined without paying", async ({ page, request }) => {
  await loadScenario(request, "needs-approval");
  await startDeterministicRun(page);
  const card = page.getByRole("region", { name: "Approval request" });
  await expect(card).toBeVisible();
  await expect(card.getByText(/Expires in \d+:\d\d/)).toBeVisible();
  await card.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Purchase declined")).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("Owner declined", { exact: true })).toBeVisible(); // written into this run's log
});

test("operations: an unanswered approval expires unpaid", async ({ page, request }) => {
  await loadScenario(request, "needs-approval");
  const settings = await request.put("/api/settings", {
    data: {
      householdName: "Adeyemi Household",
      budgetAmountNgn: 15_000,
      budgetPeriod: "monthly",
      autoPurchaseEnabled: true,
      perPurchaseLimitNgn: 5_000,
      overallAgentLimitNgn: 8_000,
      manualApprovalThresholdNgn: 1_000,
      priorities: ["electricity", "data", "airtime"],
      approvedServices: ["electricity", "airtime", "data"],
      approvedNetworks: ["mtn", "airtel", "glo", "t2"],
      approvalTtlSeconds: 10,
    },
  });
  expect(settings.ok(), await settings.text()).toBeTruthy();

  await startDeterministicRun(page);
  const card = page.getByRole("region", { name: "Approval request" });
  await expect(card.getByText(/Expires in 0:\d\d/)).toBeVisible();
  // At zero the card stops offering approval and the server closes the request unpaid.
  await expect(page.getByText("Approval expired")).toBeVisible({ timeout: 25_000 });
  await expect(card).toHaveCount(0);
  await expect(page.getByText("Approval request expired")).toBeVisible();
  const runs = await (await request.get("/api/agent/runs")).json();
  expect(runs.runs[0].status).toBe("completed");
});

test("operations: the run page has no serious accessibility violations", async ({ page, request }) => {
  await loadScenario(request, "needs-approval");
  await startDeterministicRun(page);
  await expect(page.getByRole("region", { name: "Approval request" })).toBeVisible();
  for (const d of await page.locator("li[data-stage] details").all()) await d.evaluate((el) => ((el as HTMLDetailsElement).open = true));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.target.join(" ")}`);
  expect(summary, summary.join("\n")).toEqual([]);
});

test("transactions: search and filters narrow the history", async ({ page, request }) => {
  await loadScenario(request, "needs-approval");
  await startDeterministicRun(page); // parks one PowerGrid electricity purchase (no payment)
  await page.goto("/transactions");
  const search = page.getByRole("search", { name: "Search transactions" });
  await search.getByLabel("Search").fill("powergrid");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=powergrid/);
  await expect(page.getByText("1 of 1 purchase match.")).toBeVisible();
  await search.getByLabel("Search").fill("no-such-thing");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No purchases match")).toBeVisible();
  await page.goto("/transactions?status=awaiting_approval&utility=electricity");
  await expect(page.getByText("1 of 1 purchase match.")).toBeVisible();
  await page.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/transactions$/);
});

test("accounts: each account lists the providers that can serve it", async ({ page, request }) => {
  await loadScenario(request, "provider-outage");
  await page.goto("/accounts");
  const electricity = page.locator("section").filter({ hasText: "Electricity · Home meter" }).first();
  await expect(electricity.getByText("Demo PowerGrid Vend")).toBeVisible();
  await expect(electricity.getByText("Unavailable")).toBeVisible();
  const airtime = page.locator("section").filter({ hasText: "Airtime · Owner's line" }).first();
  await expect(airtime.getByText("Demo TopUp Hub")).toBeVisible();
});

test("providers: the network is discoverable, verified, and marks paid endpoints", async ({ page, request }) => {
  await loadScenario(request, "both-low");
  const listing = await (await request.get("/api/providers")).json();
  expect(listing.providers).toHaveLength(8);
  await page.goto("/providers");
  await expect(page.getByText("Verified against registry")).toHaveCount(8);
  await expect(page.getByText("Paid · x402")).toHaveCount(8);
  await page.getByRole("link", { name: "View the published document" }).first().click();
  await expect(page).toHaveURL(/\/api\/providers\/prv_demo_electricity\/service$/);
  await expect(page.locator("body")).toContainText('"paid":true');
});
