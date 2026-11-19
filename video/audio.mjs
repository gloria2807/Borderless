/**
 * Builds the music bed and sound design for the demo video, synthesised with ffmpeg
 * (no third-party music). Narration is recorded separately by the founders and mixed in
 * with video/mux.mjs.
 *
 * Usage: node video/audio.mjs   → video/out/bed.wav (264 s, 48 kHz stereo)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const OUT = "video/out";
mkdirSync(OUT, { recursive: true });
const D = 264;
const run = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });

// Chord pad: A minor → F → C → G, 8 s per chord, three soft sine voices with slow swell.
const chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [130.81, 196, 261.63], [196, 246.94, 293.66]];
const voice = (v) => chords.map((c, i) => `between(mod(t,32),${i * 8},${i * 8 + 8})*sin(2*PI*${c[v]}*t)`).join("+");
const swell = "(0.55+0.45*sin(2*PI*mod(t,8)/16))";
const pad = `${swell}*(${voice(0)}+0.8*(${voice(1)})+0.6*(${voice(2)}))/2.4`;
run(["-f", "lavfi", "-i", `aevalsrc='${pad}':s=48000:d=${D}`, "-af", "lowpass=f=1400,aecho=0.6:0.5:120|260:0.25|0.18", `${OUT}/pad.wav`]);

// A gentle pulse for the technical scenes (eighth notes on the chord root, an octave up).
const root = chords.map((c, i) => `between(mod(t,32),${i * 8},${i * 8 + 8})*sin(2*PI*${c[0] * 2}*t)`).join("+");
run(["-f", "lavfi", "-i", `aevalsrc='(${root})*exp(-9*mod(t,0.5))':s=48000:d=${D}`, "-af", "lowpass=f=1800", `${OUT}/pulse.wav`]);

// Sound design, placed at the moments they belong to (seconds from the start).
const S6 = 176, S7 = 218;
const ticks = [4.3, 6.6, 8.6, 10.4, 12.0, 15.0, 24.6, 30.4, 33.0, 40.6].map((x) => S6 + x);
const blip = (at, f, len, gain) => `between(t,${at},${at + len})*${gain}*sin(2*PI*${f}*(t-${at}))*exp(-${(6 / len).toFixed(2)}*max(0,t-${at}))`;
const sfx = [
  blip(1.2, 2400, 0.04, 0.5), // light switch click
  blip(13.45, 2000, 0.03, 0.5), blip(13.47, 55, 0.6, 0.9), // lights out: click + low thump
  ...ticks.map((t) => blip(t, 1320, 0.07, 0.18)), // step ticks
  blip(S6 + 30.4, 880, 0.9, 0.35), blip(S6 + 30.55, 1318.5, 1.1, 0.3), // settlement chime
  blip(S6 + 32.9, 1046.5, 0.8, 0.28), blip(S6 + 33.05, 1568, 1.0, 0.22), // release chime
  blip(S7 + 9.9, 440, 0.45, 0.3), blip(S7 + 10.2, 330, 0.7, 0.3), // refusal
].join("+");
run(["-f", "lavfi", "-i", `aevalsrc='${sfx}':s=48000:d=${D}`, `${OUT}/sfx.wav`]);

// Mix: quiet, dark opening; pad drops out when the lights go off; pulse under scenes 4–7; settle at the end.
const padVol = "if(lt(t,13.45),0.10,if(lt(t,15.5),0,if(lt(t,38),0.08,if(lt(t,90),0.11,if(lt(t,238),0.10,0.12*max(0,1-(t-258)/6))))))";
const pulseVol = "if(between(t,90,236),0.05*min(1,(t-90)/3)*min(1,(236-t)/3),0)";
run([
  "-i", `${OUT}/pad.wav`, "-i", `${OUT}/pulse.wav`, "-i", `${OUT}/sfx.wav`,
  "-filter_complex",
  `[0]volume='${padVol}':eval=frame,volume=2.2[a];[1]volume='${pulseVol}':eval=frame,volume=2.2[b];[2]volume=0.9[c];[a][b][c]amix=inputs=3:normalize=0,afade=t=in:d=1.2,afade=t=out:st=${D - 3}:d=3,aformat=channel_layouts=stereo[out]`,
  "-map", "[out]", "-ar", "48000", `${OUT}/bed.wav`,
]);
console.log(`✓ ${OUT}/bed.wav`);
