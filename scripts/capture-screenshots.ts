/**
 * Captures the README screenshots from the running app, driving the real flows:
 * Scenario A (Simulate low balance → live x402 payment), B (2 USDC left), C (over-limit refusal),
 * D (paid, release failed), an approval request, and the main pages.
 *
 * Spends about 6 test USDC on Stellar testnet (three live purchases). Testnet only.
 *
 * Usage: BASE_URL=http://localhost:3001 pnpm screenshots
 */
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = "docs/images";
mkdirSync(OUT, { recursive: true });

/** Same-origin API call from inside the page (the app's actions reject cross-origin requests). */
async function api<T = Record<string, unknown>>(page: Page, path: string, body?: unknown, method = "POST"): Promise<T> {
  return page.evaluate(
    async ({ path, body, method }) => {
      const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return res.json();
    },
    { path, body, method },
  ) as Promise<T>;
}

async function waitForRun(page: Page, runId: string) {
  for (let i = 0; i < 120; i += 1) {
    const r = await api<{ run: { status: string } }>(page, `/api/agent/runs/${runId}`, undefined, "GET");
    if (r.run.status !== "running") return r.run.status;
    await page.waitForTimeout(1500);
  }
  throw new Error(`Run ${runId} did not finish`);
}

async function shotElement(page: Page, name: string, selector: string) {
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => undefined);
  await page.waitForTimeout(600);
  await page.locator(selector).first().screenshot({ path: `${OUT}/${name}.png` });
  console.log(`✓ ${name}.png`);
}

async function shot(page: Page, name: string, opts: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {}) {
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => undefined);
  await page.waitForTimeout(600); // let fade-ins settle
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.fullPage ?? false, clip: opts.clip });
  console.log(`✓ ${name}.png`);
}

const reset = (page: Page, scenario: string) => api(page, "/api/demo/reset", { scenario });

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "light" });
  // A dev server compiles each route on first request; give it time, and warm every page first.
  context.setDefaultNavigationTimeout(180_000);
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();
  for (const path of ["/", "/overview", "/agent", "/household", "/providers", "/transactions", "/settings"]) {
    await page.goto(`${BASE}${path}`);
    console.log(`  warmed ${path}`);
  }
  await page.goto(`${BASE}/overview`);
  await api(page, "/api/agent/control", { action: "resume" });

  // Landing.
  await page.goto(`${BASE}/`);
  await shot(page, "landing");

  // Overview, clean start (Scenario A).
  await reset(page, "primary-electricity");
  await page.goto(`${BASE}/overview`);
  await shot(page, "overview");

  // Scenario A: Simulate low balance → live purchase.
  const a = await api<{ runId: string }>(page, "/api/demo/low-balance", { kind: "electricity", mode: "deterministic" });
  console.log(`  Scenario A run ${a.runId}: ${await waitForRun(page, a.runId)}`);
  await page.goto(`${BASE}/agent/runs/${a.runId}`);
  await shot(page, "run-console");
  const purchaseA = await page.locator('a[href^="/transactions/pur_"]').first().getAttribute("href");

  // Procurement inspection with the provider's live 402 ("Request without paying").
  await page.goto(`${BASE}${purchaseA!.split("#")[0]}#procurement`);
  await page.getByRole("button", { name: /Request without paying/ }).click();
  await page.getByText(/Nothing was released\. Without payment|released something without payment/).waitFor({ timeout: 60_000 });
  await shotElement(page, "procurement-inspection", "#procurement");

  // Household: the credited virtual meter.
  await page.goto(`${BASE}/household`);
  await shot(page, "household");

  // Scenario B: competing needs with 2 USDC left.
  await reset(page, "budget-covers-one");
  const b = await api<{ runId: string }>(page, "/api/agent/runs", { mode: "deterministic" });
  console.log(`  Scenario B run ${b.runId}: ${await waitForRun(page, b.runId)}`);
  await page.goto(`${BASE}/agent/runs/${b.runId}`);
  await shot(page, "competing-needs");

  // Scenario C: the wallet refuses an over-limit purchase.
  await reset(page, "policy-rejection");
  const c = await api<{ runId: string }>(page, "/api/demo/over-limit");
  console.log(`  Scenario C run ${c.runId}: ${await waitForRun(page, c.runId)}`);
  await page.goto(`${BASE}/agent/runs/${c.runId}`);
  await shot(page, "policy-refusal");

  // Scenario D: paid, but the provider fails to release.
  await reset(page, "fulfilment-failure");
  const d = await api<{ runId: string }>(page, "/api/agent/runs", { mode: "deterministic" });
  console.log(`  Scenario D run ${d.runId}: ${await waitForRun(page, d.runId)}`);
  await page.goto(`${BASE}/agent/runs/${d.runId}`);
  await shot(page, "release-failed");
  // Recover it so the household isn't left with an open issue (no second payment).
  const purchaseD = (await page.locator('a[href^="/transactions/pur_"]').first().getAttribute("href"))!.split("/").pop()!.split("#")[0];
  await api(page, "/api/demo/faults", { fault: "provider_fulfilment_failure", enabled: false });
  await api(page, `/api/purchases/${purchaseD}/recover`);

  // Transactions after the live purchases.
  await page.goto(`${BASE}/transactions`);
  await shot(page, "transactions");

  // An approval request (threshold lowered by the scenario); declined afterwards, unpaid.
  await reset(page, "needs-approval");
  const e = await api<{ runId: string }>(page, "/api/agent/runs", { mode: "deterministic" });
  await waitForRun(page, e.runId).catch(() => undefined); // the run waits for the owner
  await page.goto(`${BASE}/overview`);
  await page.getByRole("region", { name: "Approval request" }).first().waitFor({ timeout: 30_000 });
  await shot(page, "approval");
  const pending = await page.locator('section[aria-label="Approval request"]').count();
  if (pending) await page.getByRole("button", { name: "Decline" }).first().click();
  await page.waitForTimeout(1500);

  // Providers and Settings.
  await reset(page, "primary-electricity");
  await page.goto(`${BASE}/providers`);
  await shot(page, "providers");
  await page.goto(`${BASE}/settings`);
  await shot(page, "settings");

  // Mobile overview.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  mobile.setDefaultNavigationTimeout(180_000);
  const m = await mobile.newPage();
  await m.goto(`${BASE}/overview`);
  await shot(m, "mobile-overview");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
