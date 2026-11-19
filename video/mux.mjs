/**
 * Final assembly.
 *
 *   node video/mux.mjs srt                 → video/out/borderless-demo.srt (from the captions in studio/engine.js)
 *   node video/mux.mjs bed                 → video/out/borderless-demo.mp4 (video + music and sound design, no voice)
 *   node video/mux.mjs voice narration.wav → video/out/borderless-demo-final.mp4
 *       narration.wav: one full-length recording (0:00 = the video's first frame). The music ducks
 *       under the voice automatically. Or pass several "file@seconds" parts, e.g.
 *       node video/mux.mjs voice s1.wav@0 s2.wav@38 s3.wav@68 …
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "video/out";
const VIDEO = `${OUT}/borderless-demo.silent.mp4`;
const run = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });

function captions() {
  const src = readFileSync("video/studio/engine.js", "utf8");
  const block = src.slice(src.indexOf("const CAPTIONS = ["), src.indexOf("];", src.indexOf("const CAPTIONS = [")));
  return [...block.matchAll(/\[([\d.]+), ([\d.]+), "((?:[^"\\]|\\.)*)"\]/g)].map((m) => [Number(m[1]), Number(m[2]), m[3].replace(/\*/g, "")]);
}
const ts = (s) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

const [mode, ...rest] = process.argv.slice(2);
if (mode === "srt") {
  const srt = captions().map(([a, b, t], i) => `${i + 1}\n${ts(a)} --> ${ts(b)}\n${t}\n`).join("\n");
  writeFileSync(`${OUT}/borderless-demo.srt`, srt);
  console.log(`✓ ${OUT}/borderless-demo.srt (${captions().length} captions)`);
} else if (mode === "bed") {
  run(["-i", VIDEO, "-i", `${OUT}/bed.wav`, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", `${OUT}/borderless-demo.mp4`]);
  console.log(`✓ ${OUT}/borderless-demo.mp4`);
} else if (mode === "voice") {
  if (!rest.length) throw new Error("Pass the narration file(s).");
  const parts = rest.map((p) => { const [file, at] = p.split("@"); return { file, at: Number(at ?? 0) }; });
  const inputs = parts.flatMap((p) => ["-i", p.file]);
  const delays = parts.map((p, i) => `[${i + 2}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)}[v${i}]`).join(";");
  const voice = parts.length > 1 ? `${parts.map((_, i) => `[v${i}]`).join("")}amix=inputs=${parts.length}:normalize=0[voice]` : "[v0]anull[voice]";
  // Voice: gentle clean-up and loudness; music ducks under it (sidechain).
  const graph = `${delays};${voice};[voice]highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=8:release=200,loudnorm=I=-16:TP=-1.5:LRA=9,asplit=2[vo][sc];[1:a][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck];[duck][vo]amix=inputs=2:normalize=0[mix]`;
  run(["-i", VIDEO, "-i", `${OUT}/bed.wav`, ...inputs, "-filter_complex", graph, "-map", "0:v", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", `${OUT}/borderless-demo-final.mp4`]);
  console.log(`✓ ${OUT}/borderless-demo-final.mp4`);
} else if (mode === "cut") {
  // The sub-3-minute cut: founders' voice (video/out/voice_cut.wav from cut.mjs) over the upbeat
  // music (music.mjs). The music ducks ~10 dB under the voice and lifts again between lines.
  const graph = [
    "[1:a]highpass=f=75,acompressor=threshold=-22dB:ratio=2.5:attack=6:release=180,loudnorm=I=-15:TP=-1.5:LRA=8,asplit=2[vo][key]",
    "[2:a]volume=0.62[mus]",
    "[mus][key]sidechaincompress=threshold=0.02:ratio=10:attack=12:release=350:makeup=1[duck]",
    "[3:a]volume=0.8[fx]",
    "[duck][vo][fx]amix=inputs=3:normalize=0,alimiter=limit=0.95[mix]",
  ].join(";");
  run(["-i", `${OUT}/borderless-cut.silent.mp4`, "-i", `${OUT}/voice_cut.wav`, "-i", `${OUT}/music.wav`, "-i", `${OUT}/sfx_cut.wav`, "-filter_complex", graph, "-map", "0:v", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", `${OUT}/borderless-demo-under3.mp4`]);
  const cut = JSON.parse(readFileSync("video/studio/cut.json", "utf8"));
  writeFileSync(`${OUT}/borderless-demo-under3.srt`, cut.captions.map(([a, b, t], i) => `${i + 1}\n${ts(a)} --> ${ts(b)}\n${t.replace(/\*/g, "")}\n`).join("\n"));
  console.log(`✓ ${OUT}/borderless-demo-under3.mp4 (+ .srt)`);
} else {
  console.log("Usage: node video/mux.mjs srt | bed | cut | voice narration.wav[@seconds] …");
}
