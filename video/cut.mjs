/**
 * The sub-3-minute cut, built from Gloria's and Hannah's recorded narration.
 *
 * Each clip is a span of their recording (source seconds, from word timestamps) with the caption
 * lines it contains. The builder places clips on a new timeline, writes video/studio/cut.json for
 * the compositor, and assembles the voice track from the recording (no words are re-ordered within
 * a clip; only whole lines are dropped).
 *
 * Usage: node video/cut.mjs <voiced.mp4>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const SRC = process.argv[2];
if (!SRC) throw new Error("Pass the voiced video (InShot export).");
const OUT = "video/out";
mkdirSync(OUT, { recursive: true });

// [id, scene, srcStart, srcEnd, [[caption, srcTimeOfFirstWord], …]]
const CLIPS = [
  ["c1", 1, 5.40, 7.75, [["You're in the middle of something important.", 5.49]]],
  ["c2", 1, 15.55, 17.25, [["Then *NEPA* takes the light.", 15.66]]],
  ["c3", 1, 18.30, 23.70, [["You check the meter.", 18.42], ["They didn't take it o — it was *your units* that finished.", 20.28]]],
  ["c4", 1, 32.60, 43.10, [["And just when you think you're done,", 32.73], ["MTN sends you a message: your data is down to *50MB* too.", 35.93], ["So now you're deciding what to pay for *between the two*.", 39.29]]],
  ["c5", 2, 67.75, 69.45, [["These are *competing household needs*.", 67.86]]],
  ["c6a", 2, 72.95, 75.25, [["Automatic payments can follow instructions,", 73.07]]],
  ["c6b", 2, 76.85, 80.85, [["but they don't know which need *matters more right now*.", 76.94]]],
  ["c7", 3, 84.45, 90.20, [["So we built *Borderless*.", 84.55], ["An autonomous household utilities agent.", 87.87]]],
  ["c8", 3, 90.50, 94.95, [["You set your household *budget*, *priorities* and spending permissions.", 90.59]]],
  ["c9", 3, 107.45, 110.40, [["You set the rules. *Borderless does the work.*", 107.58]]],
  ["c10", 4, 112.60, 116.50, [["But here's where Borderless differs from *ordinary auto-pay*.", 112.72]]],
  ["c11", 4, 116.85, 126.25, [["Imagine you have just *2 USDC* of spending authority left.", 116.94], ["Your electricity is running low.", 120.68], ["Your mobile data is running low too.", 123.91]]],
  ["c12", 4, 126.80, 129.85, [["Both matter. But you can't afford both right now.", 126.89]]],
  ["c13", 4, 133.05, 142.95, [["Borderless weighs the household's *priorities*, urgency and eligible options.", 133.16], ["It prioritises *electricity* and defers the data purchase.", 137.2], ["And it explains why.", 141.18]]],
  ["c15", 5, 173.65, 183.10, [["One decision matters most: the agent does not control *financial authority*.", 173.77], ["Every intended purchase passes through an *independent policy engine*.", 178.61]]],
  ["c17", 5, 188.85, 205.10, [["Only then can the purchase reach the *x402* payment layer.", 188.97], ["The provider protects the resource behind *HTTP 402*.", 192.19], ["Borderless validates the terms; the facilitator verifies and *settles on Stellar*.", 196.53], ["Only after settlement does the provider *release* the resource.", 201.87]]],
  ["c19", 6, 222.31, 224.85, [["We simulate a low electricity balance.", 222.4]]],
  ["c20", 6, 225.35, 232.70, [["Borderless detects the shortage, checks its spending authority", 225.47], ["and discovers an eligible electricity provider.", 228.48]]],
  ["c21", 6, 233.85, 235.60, [["It requests the purchase.", 233.96]]],
  ["c22", 6, 236.45, 244.30, [["The provider responds: *HTTP 402, Payment Required*.", 236.57], ["It won't release the protected resource until payment is *verified*.", 240.55]]],
  ["c23", 6, 245.33, 252.15, [["Borderless validates the terms against the household's permissions.", 245.43], ["It's within the authorised limit, so it proceeds.", 248.71]]],
  ["c24", 6, 253.00, 261.90, [["Using *x402 on Stellar*, it makes a real USDC payment on testnet.", 253.12], ["The provider verifies the settlement and *releases* the purchase.", 257.78]]],
  ["c25", 6, 262.30, 269.00, [["The simulated meter is credited. Borderless verifies fulfilment", 262.42], ["and generates a *receipt*.", 267.84]]],
  ["c26", 7, 283.85, 287.85, [["Here, it attempts a purchase above the authorised limit.", 283.95]]],
  ["c27", 7, 288.25, 291.15, [["The system rejects it *before payment is signed*.", 288.37]]],
  ["c28", 7, 291.90, 295.20, [["Because autonomy should never mean *losing control*.", 292.02]]],
  ["c29", 8, 312.74, 318.35, [["We started with *electricity*. The same system extends to airtime, data and more.", 312.84]]],
  ["c30", 8, 318.74, 320.65, [["This is Borderless.", 318.84]]],
  ["c31", 8, 320.92, 328.00, [["Your household stays powered and connected. *Borderless handles the rest.*", 321.02], ["Made by Gloria and Hannah.", 325.66]]],
];

// Pauses: within a scene, between scenes, and holds where the picture needs a beat.
const GAP = 0.22, SCENE_GAP = 0.7;
const LEAD = 1.8; // opening title before the first line
const HOLD_AFTER = { c4: 0.9, c13: 0.4, c17: 0.6, c28: 0.3 };
const TAIL = 2.4; // closing card after the last line

let t = LEAD;
const placed = [];
CLIPS.forEach(([id, scene, s, e, caps], i) => {
  if (i > 0) t += CLIPS[i - 1][1] === scene ? GAP : SCENE_GAP;
  const at = t;
  placed.push({ id, scene, src: [s, e], at, dur: e - s, caps: caps.map(([text, st]) => ({ text, t: +(at + (st - s)).toFixed(2) })) });
  t = at + (e - s) + (HOLD_AFTER[id] ?? 0);
});
const duration = +(t + TAIL).toFixed(2);

// Captions end when the next caption starts (or shortly after the clip ends).
const caps = placed.flatMap((p) => p.caps.map((c) => ({ ...c, clipEnd: p.at + p.dur })));
const captions = caps.map((c, i) => [c.t, +Math.min(caps[i + 1]?.t ?? Infinity, c.clipEnd + 0.35).toFixed(2), c.text]);
const scenes = [...new Set(placed.map((p) => p.scene))].map((n) => {
  const ps = placed.filter((p) => p.scene === n);
  return { n, first: ps[0].at, last: ps.at(-1).at + ps.at(-1).dur };
});
const clipAt = Object.fromEntries(placed.map((p) => [p.id, { at: +p.at.toFixed(2), end: +(p.at + p.dur).toFixed(2), src: p.src }]));
writeFileSync("video/studio/cut.json", JSON.stringify({ duration, scenes, clips: clipAt, captions }, null, 1));
console.log(`timeline ${duration.toFixed(1)} s (${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, "0")}), voice ${placed.reduce((a, p) => a + p.dur, 0).toFixed(1)} s, ${placed.length} clips`);
for (const s of scenes) console.log(`  scene ${s.n}: ${s.first.toFixed(1)}–${s.last.toFixed(1)}`);

// Voice track: each clip cut from the recording with tiny fades, placed at its new time.
const wav = `${OUT}/voiced/source48k.wav`;
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", SRC, "-vn", "-ac", "2", "-ar", "48000", wav], { stdio: "inherit" });
const parts = placed.map((p, i) => `[0:a]atrim=${p.src[0]}:${p.src[1]},asetpts=PTS-STARTPTS,afade=t=in:d=0.04,afade=t=out:st=${(p.dur - 0.08).toFixed(3)}:d=0.08,adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)}[p${i}]`).join(";");
const graph = `${parts};${placed.map((_, i) => `[p${i}]`).join("")}amix=inputs=${placed.length}:normalize=0,apad=whole_dur=${duration},atrim=0:${duration}[v]`;
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wav, "-filter_complex", graph, "-map", "[v]", "-ar", "48000", `${OUT}/voice_cut.wav`], { stdio: "inherit" });
console.log(`✓ ${OUT}/voice_cut.wav`);
