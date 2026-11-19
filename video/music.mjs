/**
 * Upbeat original music + sound design for the cut, synthesised with ffmpeg (no third-party audio),
 * arranged around the narration timings in video/studio/cut.json.
 *
 * 112 BPM, C major, I–V–vi–IV. Layers: kick, clap, hats, plucked bass, syncopated chord stabs, soft pad.
 * Usage: node video/music.mjs  → video/out/music.wav, video/out/sfx_cut.wav
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const OUT = "video/out";
const cut = JSON.parse(readFileSync("video/studio/cut.json", "utf8"));
const D = cut.duration;
const C = cut.clips;
const run = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
const B = (60 / 112).toFixed(6); // one beat, seconds
const src = (expr, file, af) => run(["-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${D}`, ...(af ? ["-af", af] : []), `${OUT}/${file}`]);

// Harmony: chord index changes every bar (4 beats).
const ci = `mod(floor(t/(4*${B})),4)`;
const pick = (a, b, c, d) => `if(eq(${ci},0),${a},if(eq(${ci},1),${b},if(eq(${ci},2),${c},${d})))`;
const f1 = pick(261.63, 246.94, 261.63, 261.63), f2 = pick(329.63, 293.66, 329.63, 349.23), f3 = pick(392.0, 392.0, 440.0, 440.0);
const root = pick(65.41, 98.0, 110.0, 87.31);
const beat = `mod(t,${B})`, eighth = `mod(t,${B}/2)`;
const beatInBar = `floor(mod(t,4*${B})/${B})`, step8 = `floor(mod(t,4*${B})/(${B}/2))`;

src(`sin(2*PI*(48*${beat}+2.6*(1-exp(-30*${beat}))))*exp(-7*${beat})`, "m_kick.wav", "lowpass=f=180");
src(`(eq(${beatInBar},1)+eq(${beatInBar},3))*(2*random(0)-1)*exp(-16*${beat})`, "m_clap.wav", "highpass=f=900,lowpass=f=6000,aecho=0.5:0.4:28:0.25");
src(`eq(mod(floor(t/(${B}/2)),2),1)*(2*random(1)-1)*exp(-55*${eighth})`, "m_hat.wav", "highpass=f=7000");
src(`tanh(1.6*sin(2*PI*${root}*t))*exp(-4.5*${eighth})`, "m_bass.wav", "lowpass=f=700");
src(`(eq(${step8},1)+eq(${step8},3)+eq(${step8},4)+eq(${step8},6))*exp(-6*${eighth})*(sin(2*PI*${f1}*t)+sin(2*PI*${f2}*t)+sin(2*PI*${f3}*t)+0.35*sin(4*PI*${f1}*t))/3.4`, "m_stab.wav", "lowpass=f=3200,aecho=0.6:0.45:180:0.22");
src(`(sin(2*PI*${f1}/2*t)+sin(2*PI*${f2}/2*t)+sin(2*PI*${f3}/2*t))/3*(0.75+0.25*sin(2*PI*t/7))`, "m_pad.wav", "lowpass=f=1200");

// Arrangement (seconds on the cut timeline).
const out = (C.c2.at + 0.95).toFixed(2); // lights out on "takes the light": music stops
const back = (C.c4.at - 0.3).toFixed(2); // the MTN text: music returns, light
const full = (cut.scenes.find((s) => s.n === 2).first - 0.6).toFixed(2); // full beat from the insight
const thin = (C.c30.at - 0.2).toFixed(2); // "This is Borderless": drums drop, harmony rings out
const on = (a, b) => `between(t,${a},${b})`;
const lvl = {
  pad: `0.30*(${on(0, out)}+${on(back, D)})`,
  stab: `0.42*(0.6*${on(0, out)}+${on(back, D)})`,
  hat: `0.16*(${on(back, thin)})`,
  kick: `0.85*${on(full, thin)}`,
  clap: `0.30*${on(full, thin)}`,
  bass: `0.42*${on(full, D)}`,
};
const order = ["kick", "clap", "hat", "bass", "stab", "pad"];
run([
  ...order.flatMap((n) => ["-i", `${OUT}/m_${n}.wav`]),
  "-filter_complex",
  `${order.map((n, i) => `[${i}]volume='${lvl[n]}':eval=frame[${n}]`).join(";")};${order.map((n) => `[${n}]`).join("")}amix=inputs=${order.length}:normalize=0,afade=t=in:d=1.0,afade=t=out:st=${(D - 3.5).toFixed(2)}:d=3.5,aformat=channel_layouts=stereo,loudnorm=I=-19:TP=-2:LRA=7[m]`,
  "-map", "[m]", "-ar", "48000", `${OUT}/music.wav`,
]);

// Sound design at the moments it belongs to.
const caps = cut.captions;
const capAt = (re) => caps.find((c) => re.test(c[2]))?.[0];
const blip = (at, f, len, gain) => `between(t,${at},${at + len})*${gain}*sin(2*PI*${f}*(t-${at}))*exp(-${(6 / len).toFixed(2)}*max(0,t-${at}))`;
const settleAt = capAt(/verifies the settlement/), refuseAt = C.c27.at;
const sfx = [
  blip(0.5, 2400, 0.04, 0.4), // switch click before the title
  blip(+out + 0.08, 2000, 0.03, 0.5), blip(+out + 0.1, 55, 0.6, 0.9), // lights out
  blip(settleAt, 880, 0.9, 0.3), blip(settleAt + 0.15, 1318.5, 1.1, 0.26), // settlement chime
  blip(refuseAt + 1.2, 440, 0.45, 0.28), blip(refuseAt + 1.5, 330, 0.7, 0.28), // refusal
].join("+");
src(sfx, "sfx_cut.wav");
console.log(`✓ ${OUT}/music.wav, ${OUT}/sfx_cut.wav (${D}s)`);
