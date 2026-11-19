/**
 * Renders the demo video from video/studio (deterministic, frame by frame) into ffmpeg.
 *
 *   node video/render.mjs stills 5 40 100      → video/out/still_<t>.png for review
 *   node video/render.mjs video [from] [to]    → video/out/borderless-demo.silent.mp4 (1920×1080, 30 fps)
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = "video";
const OUT = "video/out";
const FPS = 30;
mkdirSync(OUT, { recursive: true });
const TX = readFileSync("video/footage/scenarioA-tx.txt", "utf8").trim();

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png" };
const server = createServer((req, res) => {
  const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/(?!footage)/, "/studio/")));
  if (!path.startsWith(ROOT) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "max-age=3600" });
  createReadStream(path).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.addInitScript((tx) => { window.TX = tx; }, TX);
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(`${base}/${process.env.PAGE ?? "index.html"}`);
await page.evaluate(() => window.renderAt(0));
const duration = await page.evaluate(() => window.DURATION);

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === "stills") {
    for (const t of args.map(Number)) {
      await page.evaluate((t) => window.renderAt(t), t);
      await page.screenshot({ path: `${OUT}/still_${String(t).replace(".", "_")}.png` });
      console.log(`✓ still ${t}s`);
    }
  } else {
    const from = Number(args[0] ?? 0), to = Number(args[1] ?? duration);
    const file = args[2] ?? process.env.OUTFILE ?? `${OUT}/borderless-demo.silent.mp4`;
    const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
    const total = Math.round((to - from) * FPS);
    const started = Date.now();
    for (let i = 0; i < total; i += 1) {
      const t = from + i / FPS;
      await page.evaluate((t) => window.renderAt(t), t);
      const buf = await page.screenshot({ type: "jpeg", quality: 93 });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
      if (i % 300 === 0) console.log(`  ${t.toFixed(1)}s  (${i}/${total}, ${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
    }
    ff.stdin.end();
    await new Promise((r) => ff.on("close", r));
    console.log(`✓ ${file}`);
  }
} finally {
  await browser.close();
  server.close();
}
