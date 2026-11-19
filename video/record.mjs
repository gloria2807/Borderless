/**
 * Records real Borderless footage for the demo video.
 *
 * Drives the running app in Chromium and captures frames with the DevTools screencast (sharp
 * JPEGs at device resolution, with wall-clock timestamps). Alongside the frames it logs:
 *   - marks: when real backend events appear (run stages, purchase states), for syncing the edit;
 *   - cursor: where the pointer moved and clicked (screencasts don't include the cursor);
 *   - boxes: on-screen rectangles of elements the edit highlights.
 * Nothing is staged: every click hits the real app, and Scenario A/B make real testnet payments.
 *
 * Usage: BASE_URL=http://localhost:3001 node video/record.mjs overview settings scenarioB scenarioA scenarioC explorer
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = "video/footage";
const VIEW = { width: 1280, height: 800 };
const SCALE = 1.5; // frames at 1920×1200

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(page, path, body, method = "POST") {
  return page.evaluate(
    async ({ path, body, method }) => {
      const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return res.json();
    },
    { path, body, method },
  );
}

/** One recorded clip: frames + marks + cursor + boxes, all on one clock (ms from clip start). */
async function clip(browser, name, script) {
  const dir = `${OUT}/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, colorScheme: "light" });
  context.setDefaultNavigationTimeout(180_000);
  context.setDefaultTimeout(90_000);
  // Hide the Next.js dev badge; it isn't part of the product.
  await context.addInitScript(() => {
    const css = "nextjs-portal{display:none!important}";
    const add = () => { const s = document.createElement("style"); s.textContent = css; document.documentElement.appendChild(s); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
  });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  const frames = [];
  const marks = [];
  const cursor = [];
  const boxes = {};
  const urls = [];
  let t0 = 0;
  const now = () => Date.now() - t0;
  let n = 0;
  client.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = `f_${String(n++).padStart(5, "0")}.jpg`;
    writeFileSync(`${dir}/${file}`, Buffer.from(data, "base64"));
    frames.push({ t: Math.round(metadata.timestamp * 1000) - t0, file });
    await client.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame() && t0) urls.push({ t: now(), url: f.url().replace(BASE, "") });
  });

  const tools = {
    page,
    api: (p, b, m) => api(page, p, b, m),
    mark: (label) => { marks.push({ t: now(), label }); console.log(`  [${(now() / 1000).toFixed(1)}s] ${label}`); },
    wait: sleep,
    async goto(path) {
      await page.goto(`${BASE}${path}`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
    },
    async moveTo(locator, { click = false, dwell = 450 } = {}) {
      const el = page.locator(locator).first();
      await el.scrollIntoViewIfNeeded();
      const b = await el.boundingBox();
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      const last = cursor.at(-1) ?? { x: VIEW.width * 0.6, y: VIEW.height * 0.7 };
      cursor.push({ t: now(), x: last.x, y: last.y });
      await page.mouse.move(x, y, { steps: 18 });
      cursor.push({ t: now() + 500, x, y });
      await sleep(dwell);
      if (click) {
        cursor.push({ t: now(), x, y, click: true });
        await page.mouse.click(x, y);
      }
    },
    async box(name, locator) {
      const b = await page.locator(locator).first().boundingBox();
      if (b) boxes[name] = { t: now(), ...b, scrollY: await page.evaluate(() => window.scrollY) };
    },
    async scrollTo(y, ms = 1400) {
      const from = await page.evaluate(() => window.scrollY);
      const steps = Math.max(1, Math.round(ms / 33));
      for (let i = 1; i <= steps; i += 1) {
        const k = i / steps;
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        await page.evaluate((v) => window.scrollTo(0, v), from + (y - from) * e);
        await sleep(33);
      }
    },
    async scrollToEl(locator, offset = 120, ms = 1400) {
      const y = await page.locator(locator).first().evaluate((el, off) => el.getBoundingClientRect().top + window.scrollY - off, offset);
      await tools.scrollTo(Math.max(0, y), ms);
    },
    /** Polls a run and marks the first time each stage / event type is recorded by the server. */
    async followRun(runId) {
      const seen = new Set();
      for (let i = 0; i < 240; i += 1) {
        const r = await api(page, `/api/agent/runs/${runId}`, undefined, "GET");
        for (const e of r.events ?? []) {
          for (const key of [`stage:${e.stage}`, `event:${e.type}`]) {
            if (!seen.has(key)) { seen.add(key); tools.mark(key); }
          }
        }
        if (r.run?.status !== "running") { tools.mark(`run:${r.run?.status}`); return r; }
        await sleep(250);
      }
      throw new Error("run did not finish");
    },
  };

  await page.goto(script.startUrl ? script.startUrl() : `${BASE}/overview`); // load before the clock starts
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await client.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: VIEW.width * SCALE, maxHeight: VIEW.height * SCALE, everyNthFrame: 1 });
  t0 = Date.now();
  console.log(`● ${name}`);
  try {
    await script(tools);
  } finally {
    await sleep(600);
    await client.send("Page.stopScreencast").catch(() => undefined);
    const duration = now();
    writeFileSync(`${dir}/index.json`, JSON.stringify({ name, duration, view: VIEW, scale: SCALE, frames, marks, cursor, boxes, urls }, null, 1));
    console.log(`  ${frames.length} frames, ${(duration / 1000).toFixed(1)} s`);
    await context.close();
  }
}

const CLIPS = {
  // Overview of a healthy household, then the three utilities and the owner's authority.
  async overview(c) {
    await c.api("/api/agent/control", { action: "resume" });
    await c.api("/api/demo/reset", { scenario: "primary-electricity" });
    await c.goto("/overview");
    c.mark("overview");
    await c.box("authority", "text=Borderless can spend now, without asking");
    await c.wait(3500);
    await c.scrollToEl("text=Service runway", 140, 2200);
    c.mark("runway");
    await c.wait(2500);
    await c.scrollToEl("text=Airtime and data", 120, 1800);
    c.mark("utilities");
    await c.wait(2600);
    await c.scrollTo(0, 2000);
    c.mark("top");
    await c.wait(3000);
  },

  // The owner's settings: limits in USDC, pause and emergency stop.
  async settings(c) {
    await c.goto("/settings");
    c.mark("settings");
    await c.wait(3000);
    await c.scrollToEl("text=Spending authority", 90, 1800);
    c.mark("limits");
    await c.wait(4000);
    await c.scrollToEl("text=Provider allowlist", 90, 2200);
    c.mark("allowlist");
    await c.wait(3000);
  },

  // Scenario B: 2 USDC left, electricity and data both low. A real run (and a real payment).
  async scenarioB(c) {
    await c.api("/api/demo/reset", { scenario: "budget-covers-one" });
    await c.goto("/overview");
    c.mark("overview");
    await c.wait(3500);
    await c.goto("/agent");
    c.mark("agent");
    await c.moveTo("label:has-text('Deterministic (no AI)')", { click: true });
    await c.moveTo("button:has-text('Start run')", { click: true });
    await c.page.waitForURL(/\/agent\/runs\/run_/);
    const runId = c.page.url().split("/").pop();
    c.mark(`run:${runId}`);
    await c.followRun(runId);
    await c.wait(1500);
    c.mark("summary");
    await c.wait(6000);
    await c.scrollToEl("text=Purchases in this run", 120, 1600);
    c.mark("purchase");
    await c.wait(3000);
    await c.scrollTo(0, 1500);
    await c.wait(1500);
  },

  // Scenario A: Simulate low balance → live x402 purchase → inspection → meter.
  async scenarioA(c) {
    await c.api("/api/demo/reset", { scenario: "primary-electricity" });
    await c.goto("/overview");
    c.mark("overview");
    await c.wait(2500);
    await c.moveTo("main button:has-text('Simulate low balance')", { click: true, dwell: 700 });
    c.mark("clicked");
    await c.page.waitForURL(/\/agent\/runs\/run_/);
    const runId = c.page.url().split("/").pop();
    c.mark(`run:${runId}`);
    const run = await c.followRun(runId);
    await c.wait(2000);
    c.mark("done");
    await c.wait(3500);
    const purchase = await c.page.locator('a[href^="/transactions/pur_"]').first().getAttribute("href");
    c.mark(`purchase:${purchase}`);
    await c.moveTo("a:has-text('Inspect procurement')", { click: true });
    await c.page.waitForURL(/\/transactions\/pur_/);
    await c.page.waitForLoadState("networkidle").catch(() => undefined);
    c.mark("inspection");
    await c.wait(2500);
    await c.scrollToEl("text=4. HTTP 402 response", 160, 1800);
    c.mark("http402");
    await c.wait(3500);
    await c.scrollToEl("text=7. Policy decision", 120, 1600);
    c.mark("policy");
    await c.wait(3500);
    await c.scrollToEl("text=9. Stellar transaction", 140, 1600);
    c.mark("stellar");
    await c.wait(3500);
    await c.moveTo("button:has-text('Request without paying')", { click: true });
    c.mark("probe");
    await c.page.getByText(/Nothing was released\. Without payment/).waitFor({ timeout: 60_000 });
    await c.scrollToEl("text=Remove the payment", 160, 1400);
    c.mark("probe402");
    await c.wait(4000);
    await c.scrollToEl("text=Payment record", 100, 1600);
    c.mark("receipt");
    await c.wait(4000);
    await c.goto("/household");
    c.mark("household");
    await c.wait(4500);
    writeFileSync(`${OUT}/scenarioA-run.json`, JSON.stringify(run, null, 1));
  },

  // Scenario C: an instructed 5 USDC purchase, refused before signing.
  async scenarioC(c) {
    await c.api("/api/demo/reset", { scenario: "policy-rejection" });
    await c.goto("/overview");
    await c.wait(1500);
    await c.moveTo("aside button:has-text('Demo controls')", { click: true });
    await c.wait(1200);
    c.mark("controls");
    await c.moveTo("dialog[open] button:has-text('Attempt over-limit purchase')", { click: true, dwell: 800 });
    await c.page.waitForURL(/\/agent\/runs\/run_/);
    const runId = c.page.url().split("/").pop();
    c.mark(`run:${runId}`);
    await c.followRun(runId);
    await c.wait(1500);
    c.mark("refused");
    await c.wait(6000);
    await c.scrollToEl("text=Operator instruction (demo)", 140, 1600);
    c.mark("timeline");
    await c.wait(3000);
  },

  // The transaction on an independent explorer.
  async explorer(c) {
    const tx = process.env.TX_HASH;
    if (!tx) throw new Error("Set TX_HASH");
    c.mark("explorer");
    await c.wait(6000);
    await c.scrollTo(380, 1800);
    await c.wait(3500);
  },
};

CLIPS.explorer.startUrl = () => `https://stellar.expert/explorer/testnet/tx/${process.env.TX_HASH}`;

const browser = await chromium.launch();
try {
  for (const name of process.argv.slice(2)) await clip(browser, name, CLIPS[name]);
} finally {
  await browser.close();
}
