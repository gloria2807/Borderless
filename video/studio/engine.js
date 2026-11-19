/* Borderless demo video — deterministic compositor.
 * window.renderAt(t) draws the frame at t seconds and resolves once every image is decoded,
 * so the renderer can screenshot frame by frame. All footage is real (video/footage/*),
 * synced to the event times the recorder logged.
 */
"use strict";

// ── helpers ───────────────────────────────────────────────────────────────────
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
const inout = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const lerp = (a, b, k) => a + (b - a) * k;
const fin = (l, a, d = 0.45) => ease((l - a) / d);
/** Visible between a and b with soft edges. */
const vis = (l, a, b = Infinity, d = 0.45) => Math.min(fin(l, a, d), 1 - ease((l - (b - d)) / d));
function el(tag, cls, html, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}
const css = (e, o) => Object.assign(e.style, o);
const show = (e, o, dy = 0) => css(e, { opacity: o, transform: `translateY(${(1 - o) * dy}px)`, visibility: o <= 0.001 ? "hidden" : "visible" });
const fmt = (s) => s.replace(/\*([^*]+)\*/g, "<em>$1</em>");

const BRAND = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="19" cy="5" r="2.2" fill="currentColor"/></svg>`;
const CURSOR = `<svg class="cursor" viewBox="0 0 24 24"><path d="M4 2l15 11-6.6 1.2 3.7 7.1-3 1.5-3.7-7.1L4 20z" fill="#fff" stroke="#0c0d0c" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const LOCK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4a4e49" stroke-width="2.2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

// ── footage ───────────────────────────────────────────────────────────────────
const CLIPS = {};
const VIEW_SCALE = 1200 / 1280; // footage viewport → window content
async function loadClips(names) {
  for (const n of names) CLIPS[n] = await (await fetch(`/footage/${n}/index.json`)).json();
}
function frameAt(clip, ms) {
  const f = CLIPS[clip].frames;
  let lo = 0, hi = f.length - 1, best = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (f[m].t <= ms) { best = m; lo = m + 1; } else hi = m - 1; }
  return `/footage/${clip}/${f[best].file}`;
}
const markSec = (clip, label) => { const m = CLIPS[clip].marks.find((x) => x.label === label); return m ? m.t / 1000 : null; };

// ── browser window ────────────────────────────────────────────────────────────
function makeWindow(root, segs, opts = {}) {
  const w = el("div", "win", `
    <div class="bar"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
      <div class="url">${LOCK}<span></span></div><div class="badge"><i></i><span></span></div></div>
    <div class="view"><div class="zoom"><img alt=""><div class="hl"></div><div class="ripple"></div>${CURSOR}</div></div>`, root);
  if (opts.left != null) w.style.left = opts.left + "px";
  const url = w.querySelector(".url span"), badge = w.querySelector(".badge"), badgeText = badge.querySelector("span");
  const zoom = w.querySelector(".zoom"), img = zoom.querySelector("img"), cur = zoom.querySelector(".cursor"), rip = zoom.querySelector(".ripple"), hl = zoom.querySelector(".hl");
  let src = "";
  const segAt = (l) => segs.find((s) => l >= s.a && l < s.b) ?? segs[segs.length - 1];
  return {
    el: w,
    /** Local scene time at which clip second `sec` appears (for syncing side notes). */
    at(clip, sec) {
      for (const s of segs) {
        if (s.clip !== clip) continue;
        const l = s.a + (sec - s.from) / (s.speed ?? 1);
        if (l >= s.a && l < s.b) return l;
      }
      return null;
    },
    async update(l) {
      const s = segAt(l);
      const sl = clamp(l, s.a, s.b) - s.a;
      const ct = (s.from + sl * (s.speed ?? 1)) * 1000;
      const clip = CLIPS[s.clip];
      const next = frameAt(s.clip, ct);
      // URL: the page the recording was on at that moment.
      let path = s.clip === "explorer" ? null : "/overview";
      for (const u of clip.urls) if (u.t <= ct) path = u.url;
      url.innerHTML = s.clip === "explorer"
        ? `<b>stellar.expert</b>/explorer/testnet/tx/${(window.TX || "").slice(0, 18)}…`
        : `<b>teamborderless.vercel.app</b>${path.split("#")[0]}`;
      css(badge, { display: s.badge ? "flex" : "none" });
      if (s.badge) badgeText.textContent = s.badge;
      // Zoom: keyframes [segLocal, scale, focusX, focusY] in footage pixels.
      const k = s.zoom ?? [[0, 1, 640, 400]];
      let z = k[0];
      for (let i = 0; i < k.length; i++) {
        if (sl >= k[i][0]) z = k[i];
        if (i + 1 < k.length && sl >= k[i][0] && sl < k[i + 1][0]) {
          const p = inout((sl - k[i][0]) / (k[i + 1][0] - k[i][0]));
          z = [sl, lerp(k[i][1], k[i + 1][1], p), lerp(k[i][2], k[i + 1][2], p), lerp(k[i][3], k[i + 1][3], p)];
          break;
        }
      }
      const sc = z[1], fx = z[2] * VIEW_SCALE, fy = z[3] * VIEW_SCALE;
      const m = clamp((sc - 1) * 1.6);
      const cx = lerp(fx, 600, m), cy = lerp(fy, 375, m);
      const tx = clamp(cx - fx * sc, 1200 - 1200 * sc, 0), ty = clamp(cy - fy * sc, 750 - 750 * sc, 0);
      zoom.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`;
      // Highlight ring.
      if (s.hl && sl >= s.hl.from && sl < (s.hl.to ?? 1e9)) {
        css(hl, { display: "block", left: s.hl.x * VIEW_SCALE + "px", top: s.hl.y * VIEW_SCALE + "px", width: s.hl.w * VIEW_SCALE + "px", height: s.hl.h * VIEW_SCALE + "px", opacity: fin(sl, s.hl.from, 0.4) });
      } else hl.style.display = "none";
      // Cursor: real pointer path logged during recording.
      const ks = clip.cursor ?? [];
      let shown = false;
      if (ks.length && !s.noCursor) {
        let i = ks.findIndex((q) => q.t > ct);
        if (i === -1) i = ks.length;
        const prev = ks[i - 1], nx = ks[i];
        const near = (prev && ct - prev.t < 3200) || (nx && nx.t - ct < 700);
        if (prev && near) {
          let x = prev.x, y = prev.y;
          if (nx && !nx.click) { const p = inout((ct - prev.t) / Math.max(1, nx.t - prev.t)); x = lerp(prev.x, nx.x, p); y = lerp(prev.y, nx.y, p); }
          css(cur, { display: "block", left: x * VIEW_SCALE + "px", top: y * VIEW_SCALE + "px" });
          shown = true;
          const click = ks.filter((q) => q.click && ct >= q.t && ct - q.t < 650).pop();
          if (click) {
            const p = (ct - click.t) / 650;
            css(rip, { display: "block", left: click.x * VIEW_SCALE + "px", top: click.y * VIEW_SCALE + "px", opacity: 1 - p, transform: `scale(${0.4 + p})` });
          } else rip.style.display = "none";
        }
      }
      if (!shown) { cur.style.display = "none"; rip.style.display = "none"; }
      if (next !== src) {
        src = next;
        img.src = next;
        await img.decode().catch(() => undefined);
      }
    },
  };
}

// ── side panel ────────────────────────────────────────────────────────────────
function makeSide(root, { eyebrow, heading, items }, opts = {}) {
  const s = el("div", "side", `<div class="label eyebrow">${eyebrow}</div><h2>${fmt(heading)}</h2><ul></ul>`, root);
  if (opts.top) s.style.top = opts.top + "px";
  const h = s.querySelector("h2"), ey = s.querySelector(".eyebrow");
  const lis = items.map((it) => {
    const li = el("li", (it.step ? "step " : "") + (it.cls || ""), it.step ? `<span class="tick">✓</span><span>${fmt(it.text)}</span>` : fmt(it.text), s.querySelector("ul"));
    return { li, it };
  });
  return {
    update(l, headingAt = 0.2) {
      show(ey, fin(l, headingAt - 0.1), 8);
      show(h, fin(l, headingAt), 14);
      for (const { li, it } of lis) {
        const at = typeof it.at === "function" ? it.at() : it.at;
        if (it.step) {
          const done = typeof it.done === "function" ? it.done() : it.done;
          li.classList.toggle("done", done != null && l >= done);
          li.classList.toggle("now", done != null && l < done && l >= at);
          li.classList.toggle("todo", l < at);
          show(li, 1, 0);
        } else show(li, at == null ? 0 : fin(l, at, 0.4), 10);
      }
    },
  };
}

// ── full-bleed statement card ────────────────────────────────────────────────
function makeStatement(root, lines, { dark = true, size = 76 } = {}) {
  const c = el("div", "abs", "", root);
  css(c, { inset: "0", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 160px", background: dark ? "var(--ink)" : "var(--bg)", color: dark ? "#fff" : "var(--ink)" });
  const ls = lines.map(([text, at, color]) => {
    const d = el("div", "", fmt(text), c);
    css(d, { fontSize: size + "px", fontWeight: 700, letterSpacing: "-.04em", lineHeight: 1.08, color: color || "inherit" });
    d.querySelectorAll("em").forEach((e) => css(e, { fontStyle: "normal", color: dark ? "var(--green-bright)" : "var(--green)" }));
    return { d, at };
  });
  return { el: c, update(l, a, b) { css(c, { opacity: vis(l, a, b, 0.35), visibility: l >= a && l < b ? "visible" : "hidden" }); for (const x of ls) show(x.d, fin(l, a + x.at, 0.5), 18); } };
}

// ── scenes ────────────────────────────────────────────────────────────────────
const SCENES = [];
const scene = (start, end, dark, build) => SCENES.push({ start, end, dark, build });

// S1 — the shared experience (0–38).
scene(0, 38, true, (root) => {
  root.classList.add("dark");
  const t1 = el("div", "abs", "We've all been here before.", root);
  css(t1, { left: "0", right: "0", top: "440px", textAlign: "center", fontSize: "74px", fontWeight: 700, letterSpacing: "-.04em" });
  // An evening at the laptop — drawn, not stock footage.
  const room = el("div", "abs", `
    <div style="position:absolute;inset:0;background:radial-gradient(ellipse 900px 620px at 50% 46%, rgba(243,199,122,.30), rgba(243,199,122,.06) 55%, transparent 75%)"></div>
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" style="position:absolute;inset:0">
      <line x1="460" y1="770" x2="1460" y2="770" stroke="rgba(255,255,255,.28)" stroke-width="3"/>
      <rect x="700" y="405" width="520" height="330" rx="16" fill="#151614" stroke="rgba(255,255,255,.5)" stroke-width="3"/>
      <rect x="718" y="423" width="484" height="294" rx="8" fill="#22261f"/>
      <rect x="736" y="441" width="220" height="150" rx="10" fill="#2f3a2c"/><rect x="964" y="441" width="220" height="150" rx="10" fill="#33302a"/>
      <circle cx="846" cy="500" r="26" fill="#55634f"/><rect x="806" y="532" width="80" height="44" rx="22" fill="#55634f"/>
      <circle cx="1074" cy="500" r="26" fill="#6b5f4b"/><rect x="1034" y="532" width="80" height="44" rx="22" fill="#6b5f4b"/>
      <g id="wave"></g>
      <path d="M640 735h640l-40 35H680z" fill="#151614" stroke="rgba(255,255,255,.5)" stroke-width="3"/>
      <rect x="1290" y="610" width="70" height="120" rx="12" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="3"/>
      <path d="M1300 600q25-50 50 0" fill="none" stroke="rgba(243,199,122,.7)" stroke-width="3"/>
    </svg>
    <div class="label" style="position:absolute;left:0;right:0;top:300px;text-align:center;color:rgba(255,255,255,.55)">Evening · on a call</div>`, root);
  css(room, { inset: "0" });
  const wave = room.querySelector("#wave");
  // The prepaid meter, out of units.
  const meter = el("div", "abs", `
    <div style="width:520px;padding:22px;border-radius:26px;background:#151614;box-shadow:0 0 0 2px rgba(255,255,255,.18)">
      <div style="border-radius:14px;background:#dfe6d3;padding:22px 26px;color:#1b2615">
        <div class="mono" style="font-size:16px;letter-spacing:.14em;color:#4f5d43;display:flex;justify-content:space-between"><span>CREDIT</span><span id="nc" style="color:#b8392a">NO CREDIT</span></div>
        <div class="mono" style="font-size:96px;text-align:right;line-height:1.05;margin-top:8px">0.0<span style="font-size:30px;color:#4f5d43"> kWh</span></div>
        <div class="mono" style="font-size:15px;color:#4f5d43;margin-top:6px">PREPAID METER</div>
      </div>
    </div>
    <div class="label" style="margin-top:26px;text-align:center;color:rgba(255,255,255,.6)">How much should I buy?</div>`, root);
  css(meter, { left: "700px", top: "300px" });
  const nc = meter.querySelector("#nc");
  // A data-balance text message.
  const note = el("div", "abs", `
    <div style="width:620px;border-radius:24px;background:rgba(251,250,247,.96);color:#0c0d0c;padding:20px 24px;box-shadow:0 24px 60px -20px rgba(0,0,0,.6)">
      <div style="display:flex;justify-content:space-between;font-size:17px;color:#4a4e49"><b style="color:#0c0d0c">MTN</b><span>now</span></div>
      <div style="font-size:26px;font-weight:600;margin-top:8px;letter-spacing:-.01em">Your data balance is 50MB.</div>
    </div>`, root);
  css(note, { left: "650px", top: "180px" });
  const end = el("div", "abs", `<div id="e1" style="font-size:84px;font-weight:700;letter-spacing:-.045em;line-height:1.05"><span>Electricity.</span> <span>Airtime.</span> <span>Data.</span></div>
    <div id="e2" style="margin-top:22px;font-size:46px;font-weight:600;letter-spacing:-.03em;color:rgba(255,255,255,.7)">Different services. <span style="color:var(--green-bright)">One household budget.</span></div>`, root);
  css(end, { left: "160px", top: "400px" });
  const words = end.querySelectorAll("#e1 span"), e2 = end.querySelector("#e2");
  return (l) => {
    show(t1, vis(l, 1.6, 6.0), 16);
    const lightsOn = l >= 6.0 && l < 13.5;
    css(room, { opacity: lightsOn ? fin(l, 6.0, 1.2) : 0, visibility: lightsOn ? "visible" : "hidden" });
    wave.innerHTML = Array.from({ length: 14 }, (_, i) => { const h = 6 + 18 * Math.abs(Math.sin(l * 6 + i * 0.9)); return `<rect x="${820 + i * 20}" y="${650 - h / 2}" width="8" height="${h}" rx="4" fill="rgba(143,216,176,.75)"/>`; }).join("");
    show(meter, vis(l, 15.6, 26.6), 20);
    nc.style.opacity = Math.floor(l * 2) % 2 ? 1 : 0.25;
    show(note, vis(l, 27.0, 33.0), -30);
    words.forEach((w, i) => show(w, fin(l, 33.2 + i * 0.6, 0.4), 12));
    show(e2, fin(l, 35.0, 0.5), 12);
    css(end, { opacity: l >= 33 ? 1 : 0 });
  };
});

// S2 — the insight (38–68).
scene(38, 68, false, (root) => {
  root.classList.add("light", "grid");
  const win = makeWindow(root, [{ a: 0, b: 15.4, clip: "overview", from: 0.6, speed: 1.15 }]);
  const side = makeSide(root, {
    eyebrow: "01 · The problem",
    heading: "Three services. *One budget.*",
    items: [
      { at: 2.0, text: "Monitor <b>three balances</b>" },
      { at: 5.0, text: "Anticipate <b>shortages</b>", cls: "amber" },
      { at: 8.0, text: "Decide what <b>deserves attention</b>", cls: "cyan" },
      { at: 11.0, text: "Pay for each one, <b>by hand</b>", cls: "coral" },
    ],
  });
  // Competing needs → one budget.
  const g = el("div", "abs", `
    <div class="label" style="position:absolute;left:0;right:0;top:150px;text-align:center;color:var(--green)">Competing household needs</div>
    ${[["Electricity", "Runs out in 25 h", "#b8392a", 520], ["Airtime", "8 days left", "#0a6577", 840], ["Mobile data", "Runs out in 27 h", "#8f5b00", 1160]].map(([t, s, c, x], i) => `
      <div class="card need" style="position:absolute;left:${x}px;top:250px;width:240px;padding:22px 24px"><div style="width:12px;height:12px;border-radius:50%;background:${c}"></div>
      <div style="margin-top:12px;font-size:28px;font-weight:700;letter-spacing:-.02em">${t}</div><div style="margin-top:4px;font-size:18px;color:var(--fg3)">${s}</div></div>`).join("")}
    <svg width="1920" height="1080" style="position:absolute;inset:0"><g id="lines" stroke="#5f635c" stroke-width="2.5" stroke-dasharray="8 7" fill="none">
      <path d="M640 400 C640 480 960 470 960 560"/><path d="M960 400 L960 560"/><path d="M1280 400 C1280 480 960 470 960 560"/></g></svg>
    <div id="budget" style="position:absolute;left:760px;top:570px;width:400px;height:96px;border-radius:99px;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;gap:14px;font-size:30px;font-weight:700;letter-spacing:-.02em">One household budget</div>`, root);
  css(g, { inset: "0", background: "var(--bg)" });
  const needs = g.querySelectorAll(".need"), lines = g.querySelector("#lines"), budget = g.querySelector("#budget");
  const q = makeStatement(root, [["What if your household could", 0], ["*delegate* that responsibility?", 0.5]], { dark: false, size: 80 });
  return (l) => {
    css(win.el, { opacity: vis(l, 0, 15.4, 0.4) });
    side.update(l);
    root.querySelector(".side").style.opacity = vis(l, 0, 15.4, 0.4);
    const gv = vis(l, 15.2, 26.2, 0.5);
    css(g, { opacity: gv, visibility: gv > 0 ? "visible" : "hidden" });
    needs.forEach((n, i) => show(n, fin(l, 15.8 + i * 0.5, 0.5), 16));
    lines.style.opacity = fin(l, 17.6, 0.8);
    lines.style.strokeDashoffset = -l * 30;
    show(budget, fin(l, 18.4, 0.6), 16);
    q.update(l, 26.0, 30.1);
    return win.update(clamp(l, 0, 15.39));
  };
});

// S3 — introducing Borderless (68–90).
scene(68, 90, false, (root) => {
  root.classList.add("light", "grid");
  const logo = el("div", "abs", `<div style="display:flex;align-items:center;justify-content:center;gap:22px;color:var(--ink)"><span style="width:96px;height:96px;color:var(--green);display:block">${BRAND}</span><span style="font-size:120px;font-weight:700;letter-spacing:-.05em">Borderless</span></div>
    <div style="margin-top:22px;text-align:center;font-size:34px;color:var(--fg2);letter-spacing:-.015em">Your household stays powered and connected. <b style="color:var(--ink)">Borderless handles the rest.</b></div>`, root);
  css(logo, { left: "0", right: "0", top: "380px" });
  const win1 = makeWindow(root, [{ a: 0, b: 8.2, clip: "settings", from: 5.6, speed: 1, zoom: [[0, 1, 640, 400], [2.4, 1.18, 560, 330]] }]);
  const win2 = makeWindow(root, [{ a: 0, b: 9, clip: "overview", from: 1.0, speed: 0.5, zoom: [[0, 1, 640, 400], [1.6, 1.42, 1060, 560]] }]);
  const side1 = makeSide(root, { eyebrow: "02 · You set the rules", heading: "You set the rules.", items: [
    { at: 1.0, text: "Automatic purchases up to <b>2 USDC</b>" },
    { at: 2.0, text: "Owner approval <b>above 2 USDC</b>", cls: "amber" },
    { at: 3.0, text: "<b>4 USDC</b> per task · <b>10 USDC</b> per day", cls: "cyan" },
    { at: 4.0, text: "Pause or <b>emergency stop</b>, any time", cls: "coral" },
  ] });
  const side2 = makeSide(root, { eyebrow: "02 · Borderless does the work", heading: "Borderless does the work.", items: [
    { at: 0.8, text: "Monitors and <b>forecasts</b>" },
    { at: 2.4, text: "Discovers <b>eligible providers</b>", cls: "cyan" },
    { at: 4.0, text: "Evaluates <b>options</b>", cls: "amber" },
    { at: 5.6, text: "Buys <b>within its authority</b>", cls: "ink" },
  ] });
  const [s1, s2] = root.querySelectorAll(".side");
  return async (l) => {
    show(logo, vis(l, 0.2, 5.6, 0.5), 18);
    const a = vis(l, 5.6, 13.8, 0.4), b = vis(l, 13.6, 22.2, 0.4);
    css(win1.el, { opacity: a, visibility: a > 0 ? "visible" : "hidden" }); s1.style.opacity = a;
    css(win2.el, { opacity: b, visibility: b > 0 ? "visible" : "hidden" }); s2.style.opacity = b;
    side1.update(l - 5.6); side2.update(l - 13.6);
    const p = [];
    if (a > 0) p.push(win1.update(clamp(l - 5.6, 0, 8.19)));
    if (b > 0) p.push(win2.update(clamp(l - 13.6, 0, 8.99)));
    await Promise.all(p);
  };
});

// S4 — Scenario B, the differentiator (90–126).
scene(90, 126, false, (root) => {
  root.classList.add("light", "grid");
  const win = makeWindow(root, [
    { a: 0, b: 11, clip: "scenarioB", from: 0.8, speed: 0.42, noCursor: true, zoom: [[0, 1, 640, 400], [2.8, 1.5, 520, 250], [6.6, 1.5, 520, 250], [8.4, 1.28, 480, 95], [11, 1.28, 480, 95]], hl: { from: 3.8, to: 6.7, x: 437, y: 207, w: 182, h: 92 } },
    { a: 11, b: 14.6, clip: "scenarioB", from: 5.3, speed: 1 },
    { a: 14.6, b: 27, clip: "scenarioB", from: 8.6, speed: 1, badge: "1× · live run" },
    { a: 27, b: 33, clip: "scenarioB", from: 22.0, speed: 1, zoom: [[0, 1, 640, 400], [1.2, 1.42, 560, 420]] },
    { a: 33, b: 36, clip: "scenarioB", from: 28.0, speed: 1 },
  ]);
  const side = makeSide(root, { eyebrow: "03 · The differentiator", heading: "*2 USDC.* Two competing needs. One decision.", items: [
    { at: 4.0, text: "<b>2.00 USDC</b> of authority left", cls: "amber" },
    { at: 7.0, text: "Electricity: about <b>25 h</b> left", cls: "coral" },
    { at: 9.4, text: "Mobile data: about <b>27 h</b> left", cls: "coral" },
    { at: 16.6, text: "Owner's priority: <b>electricity first</b>", cls: "ink" },
    { at: () => win.at("scenarioB", markSec("scenarioB", "run:completed")), text: "Bought <b>2.00 USDC</b> of electricity" },
    { at: () => (win.at("scenarioB", markSec("scenarioB", "run:completed")) ?? 26) + 1.4, text: "Deferred data, <b>and said why</b>", cls: "cyan" },
  ] });
  const st = makeStatement(root, [["Auto-pay follows instructions.", 0], ["Borderless makes *purchasing decisions.*", 0.7]]);
  return (l) => {
    side.update(l);
    st.update(l, 31.0, 36.2);
    return win.update(clamp(l, 0, 32.99));
  };
});

// S5 — architecture (126–176).
scene(126, 176, false, (root) => {
  root.classList.add("light", "grid");
  const head = el("div", "abs", `<div class="label" style="color:var(--green)">04 · How it works — from the repository</div>
    <div style="margin-top:14px;font-size:54px;font-weight:700;letter-spacing:-.04em">The agent decides. <span style="color:#8f5b00">Code authorises.</span> <span style="color:var(--green)">x402 pays.</span></div>`, root);
  css(head, { left: "46px", top: "96px" });
  const L = [
    ["01 · Household owner", "Household owner", "Budget, utility priorities, permissions and approval rules.", "Settings · agent_policies"],
    ["02 · Agent", "Borderless agent", "Observes, forecasts depletion, discovers services, evaluates offers, selects an action.", "agent/runtime · engine.ts"],
    ["03 · Policy engine", "Independent policy engine", "Provider eligibility, quote integrity, limits, wallet balance, pending commitments, approval.", "household/policy.ts · 11 checks"],
    ["04 · x402 buyer", "x402 buyer + Stellar wallet", "Requests the resource, gets HTTP 402, validates the terms, signs the authorised payment.", "payments/x402-buyer.ts · key server-side"],
    ["05 · Provider", "Provider + facilitator", "Facilitator settles on Stellar testnet. Provider verifies settlement before release.", "providers/purchase-handler.ts"],
    ["06 · Records", "Fulfilment + records", "Simulated credit released, meter updated; payment, fulfilment and receipt kept separate.", "transactions/* · receipts"],
  ];
  const X = (i) => 46 + i * (268 + 44);
  const boxes = L.map(([n, h, p, f], i) => { const b = el("div", "layer" + (i === 2 ? " policy" : ""), `<div class="n">${n}</div><h3>${h}</h3><p>${p}</p><div class="f">${f}</div>`, root); b.style.left = X(i) + "px"; return b; });
  const arrows = [0, 1, 2, 3, 4].map((i) => { const a = el("div", "arrow", "", root); css(a, { left: X(i) + 268 + 6 + "px", width: "32px" }); return a; });
  const reveal = [2.4, 6.4, 17.0, 25.2, 28.4, 39.2];
  const planner = el("div", "abs", `<div style="width:268px;padding:12px 14px;border-radius:12px;background:var(--bg2);font-size:14.5px;line-height:1.4;color:var(--fg2)"><b style="color:var(--ink)">AI planner or deterministic planner.</b> Same tools, same rules. This recording uses the deterministic path.</div>`, root);
  css(planner, { left: X(1) + "px", top: "648px" });
  const guard = el("div", "abs", `<div style="width:268px;padding:12px 14px;border-radius:12px;background:#f8ebcf;font-size:14.5px;line-height:1.4;color:#5c3b00"><b>Code, not the model.</b> The agent can't raise its own authority or approve itself.</div>`, root);
  css(guard, { left: X(2) + "px", top: "648px" });
  const key = el("div", "abs", `<div style="width:268px;padding:12px 14px;border-radius:12px;background:var(--bg2);font-size:14.5px;line-height:1.4;color:var(--fg2)"><b style="color:var(--ink)">The model never holds the key.</b> Signing happens in server code, after the policy passes.</div>`, root);
  css(key, { left: X(3) + "px", top: "648px" });
  const states = el("div", "abs", `<span class="chip" style="background:var(--green-soft);color:var(--green)">Payment confirmed</span> <span class="chip" style="background:var(--green-soft);color:var(--green)">Utility released</span><div style="margin-top:8px;font-size:14.5px;color:var(--fg3)">Two separate records.</div>`, root);
  css(states, { left: X(5) + "px", top: "648px", width: "268px" });
  const tags = [["intent", 1], ["allowed ✓", 2], ["HTTP 402 → signed", 3], ["settled · verified", 4], ["released → receipt", 5]].map(([t, i]) => { const d = el("div", "flowtag", t, root); css(d, { left: X(i) - 22 + "px", top: "246px", transform: "translateX(-50%)" }); return d; });
  const dot = el("div", "dot", "", root);
  const chips = el("div", "abs", ["Household policy", "Agent orchestration", "Provider discovery", "Independent policy enforcement", "HTTP 402", "x402 payment", "Stellar testnet settlement", "Provider verification", "Fulfilment", "Receipt"].map((t) => `<span class="chip" style="background:var(--surface);box-shadow:var(--ring);color:var(--fg2);font-weight:500;font-size:15px;height:30px;margin:0 6px 8px 0">${t}</span>`).join(""), root);
  css(chips, { left: "46px", right: "46px", top: "800px" });
  return (l) => {
    show(head, fin(l, 0.2, 0.6), 14);
    boxes.forEach((b, i) => show(b, fin(l, reveal[i], 0.6), 22));
    arrows.forEach((a, i) => { a.style.opacity = fin(l, reveal[i + 1] - 0.2, 0.5); });
    show(planner, fin(l, 9.0, 0.5), 10);
    show(guard, fin(l, 13.6, 0.5), 10);
    show(key, fin(l, 26.2, 0.5), 10);
    show(states, fin(l, 40.2, 0.5), 10);
    // The purchase flowing through the layers (l 41–48.5).
    const p = clamp((l - 41) / 7.5);
    const seg = p * 5, i = Math.min(4, Math.floor(seg)), k = inout(seg - i);
    css(dot, { left: lerp(X(i) + 134, X(i + 1) + 134, k) + "px", top: "300px", opacity: l >= 41 && l < 49.6 ? 1 : 0 });
    boxes.forEach((b, j) => b.classList.toggle("lit", l >= 41 && Math.abs(seg - j) < 0.5));
    tags.forEach((t, j) => show(t, l >= 41 ? fin(seg, j + 0.5, 0.3) : 0, 6));
    show(chips, fin(l, 44.0, 0.6), 12);
  };
});

// S6 — the live electricity purchase (176–218).
scene(176, 218, false, (root) => {
  root.classList.add("light", "grid");
  const win = makeWindow(root, [
    { a: 0, b: 4.5, clip: "scenarioA", from: 0.6, speed: 1 },
    // The agent's first second, slowed down (badge says so): observe → need → discover → decide → request.
    { a: 4.5, b: 11.6, clip: "scenarioA", from: 5.1, speed: 0.16, badge: "0.16× · slowed to show each step" },
    // Close-ups from this purchase's own record, then the provider refusing an unpaid request, live.
    { a: 11.6, b: 15.6, clip: "scenarioA", from: 29.9, speed: 1, zoom: [[0, 1, 640, 400], [0.9, 1.55, 560, 190]] },
    { a: 15.6, b: 19.8, clip: "scenarioA", from: 47.6, speed: 0.8, zoom: [[0, 1.1, 640, 300], [0.9, 1.45, 520, 290]] },
    { a: 19.8, b: 26.4, clip: "scenarioA", from: 35.6, speed: 0.6, zoom: [[0, 1.12, 640, 240], [1.0, 1.32, 600, 230]] },
    // Back to the live run: signing and settlement at real speed (the settlement wait is shortened).
    { a: 26.4, b: 30.6, clip: "scenarioA", from: 6.6, speed: 1, badge: "1× · live run, real time" },
    { a: 30.6, b: 33.8, clip: "scenarioA", from: 15.8, speed: 1, badge: "1× · live · settlement wait shortened" },
    // The evidence.
    { a: 33.8, b: 36.6, clip: "scenarioA", from: 41.3, speed: 1, zoom: [[0, 1.1, 640, 220], [0.9, 1.45, 620, 200]] },
    { a: 36.6, b: 38.8, clip: "explorer", from: 0.4, speed: 1, zoom: [[0, 1, 640, 400], [1.0, 1.25, 560, 330]] },
    { a: 38.8, b: 40.4, clip: "scenarioA", from: 53.8, speed: 1, zoom: [[0, 1.12, 700, 380]] },
    { a: 40.4, b: 42, clip: "scenarioA", from: 59.0, speed: 1, zoom: [[0, 1.0, 640, 400], [1.0, 1.3, 400, 300]] },
  ]);
  const side = makeSide(root, { eyebrow: "05 · Live on Stellar testnet", heading: "One electricity purchase, end to end.", items: [
    { step: true, at: 0, done: 4.3, text: "Low balance simulated" },
    { step: true, at: 4.3, done: 6.6, text: "Shortage detected" },
    { step: true, at: 6.6, done: 8.6, text: "Spending authority checked" },
    { step: true, at: 8.6, done: 10.4, text: "Eligible provider discovered" },
    { step: true, at: 10.4, done: 12.0, text: "Quote retrieved: 2 USDC" },
    { step: true, at: 12.0, done: 15.0, text: "Provider answers <b>HTTP 402</b>" },
    { step: true, at: 20.8, done: 24.6, text: "Policy checks pass, before signing" },
    { step: true, at: 26.4, done: 30.4, text: "Signed · <b>settled on Stellar</b>" },
    { step: true, at: 30.6, done: 33.0, text: "Provider verified · units released" },
    { step: true, at: 33.0, done: 40.6, text: "Meter credited · receipt issued" },
  ] });
  const proof = el("div", "proof", `<div class="k">Real settlement · verified on Horizon</div><div class="h">${(window.TX || "").slice(0, 10)}…${(window.TX || "").slice(-8)}</div>
    <div class="r">Ledger 5,780,559 · <b style="color:#fff">2.0000000 USDC</b><br>GAT3…XCJV (agent) → GDTQ…A3JC (provider payee)</div>`, root);
  const n1 = el("div", "note", "Real Stellar testnet settlement — test USDC, no monetary value.", root);
  css(n1, { left: "72px", top: "905px" });
  const n2 = el("div", "note", "Simulated utility provider and virtual meter.", root);
  css(n2, { left: "860px", top: "905px" });
  return (l) => {
    side.update(l);
    show(proof, vis(l, 34.2, 38.8, 0.4), 14);
    n1.style.opacity = fin(l, 1, 0.6); n2.style.opacity = fin(l, 1, 0.6);
    return win.update(clamp(l, 0, 41.99));
  };
});

// S7 — trust and financial control (218–238).
scene(218, 238, false, (root) => {
  root.classList.add("light", "grid");
  const win = makeWindow(root, [
    { a: 0, b: 5.4, clip: "scenarioC", from: 2.4, speed: 1 },
    { a: 5.4, b: 9.4, clip: "scenarioC", from: 7.8, speed: 1, badge: "1× · live run" },
    { a: 9.4, b: 16.2, clip: "scenarioC", from: 11.8, speed: 1, zoom: [[0, 1, 640, 400], [1.0, 1.45, 600, 330]] },
  ]);
  const side = makeSide(root, { eyebrow: "06 · Trust", heading: "Autonomy, *within limits.*", items: [
    { at: 7.0, text: "Instructed: buy <b>5.00 USDC</b> of electricity", cls: "amber" },
    { at: 8.6, text: "Owner's maximum: <b>4.00 USDC</b> per request", cls: "ink" },
    { at: 10.4, text: "<b>Refused before signing</b>", cls: "coral" },
    { at: 12.0, text: "No payment. No settlement.", cls: "coral" },
  ] });
  const st = makeStatement(root, [["The AI proposes.", 0], ["The code *enforces.*", 0.6]], { size: 96 });
  return (l) => {
    side.update(l);
    st.update(l, 15.9, 20.2);
    return win.update(clamp(l, 0, 16.19));
  };
});

// S8 — the bigger possibility, and close (238–264).
scene(238, 264, false, (root) => {
  root.classList.add("light", "grid");
  const win = makeWindow(root, [{ a: 0, b: 14.2, clip: "overview", from: 6.8, speed: 1 }]);
  const side = makeSide(root, { eyebrow: "07 · What's next", heading: "Electricity first. *Every household service* next.", items: [
    { at: 3.0, text: "Electricity: <b>live today</b>" },
    { at: 7.0, text: "Airtime and data: <b>same agent, same rules</b>", cls: "cyan" },
    { at: 10.5, text: "Any service sold <b>per request</b>", cls: "ink" },
  ] });
  const fin2 = el("div", "abs", `<div style="display:flex;align-items:center;justify-content:center;gap:22px"><span style="width:92px;height:92px;color:var(--green);display:block">${BRAND}</span><span style="font-size:126px;font-weight:800;letter-spacing:-.05em">BORDERLESS</span></div>
    <div style="margin-top:18px;text-align:center;font-size:36px;font-weight:600;letter-spacing:-.02em">Autonomous Household Utilities Agent</div>
    <div style="margin-top:14px;text-align:center;font-size:30px;color:var(--fg2)">You set the rules. <b style="color:var(--green)">Your agent handles the rest.</b></div>
    <div class="label" style="margin-top:46px;text-align:center;color:var(--fg3)">teamborderless.vercel.app · x402 on Stellar testnet</div>`, root);
  css(fin2, { left: "0", right: "0", top: "330px" });
  return (l) => {
    const a = vis(l, 0, 14.4, 0.5);
    css(win.el, { opacity: a }); root.querySelector(".side").style.opacity = a;
    side.update(l);
    show(fin2, fin(l, 14.6, 0.8), 18);
    return a > 0 ? win.update(clamp(l, 0, 14.19)) : undefined;
  };
});

// ── captions (the narration, timed) ───────────────────────────────────────────
const CAPTIONS = [
  [5.2, 8.0, "You're in the middle of something *important*."],
  [8.0, 10.6, "Maybe you're working, on a call,"],
  [10.6, 13.3, "or finally getting a chance to relax."],
  [13.6, 15.6, "Then *NEPA* takes the light."],
  [15.8, 17.4, "You check the meter."],
  [17.4, 20.6, "They didn't take it o — it was *your units* that finished."],
  [20.8, 23.6, "Now you're checking your account balance,"],
  [23.6, 26.6, "figuring out how much to buy to reload your meter."],
  [26.8, 29.4, "And just when you think you're done,"],
  [29.4, 32.6, "MTN sends you a message: your data is down to *50MB* too."],
  [32.8, 36.8, "So now you're deciding what you need to pay for *between the two*."],
  [38.4, 41.6, "We realised the problem isn't simply *forgetting to recharge*."],
  [41.6, 45.4, "It's the constant responsibility of *monitoring* different services,"],
  [45.4, 48.6, "anticipating shortages, deciding what deserves attention"],
  [48.6, 50.8, "and manually making purchases."],
  [51.0, 54.4, "When money is limited, it brings pressure, frustration and exhaustion."],
  [54.4, 56.4, "These are *competing household needs*."],
  [56.6, 59.4, "Now, why not automate everything?"],
  [59.4, 62.6, "Automatic payments can follow instructions,"],
  [62.6, 65.6, "but they don't know which need *matters more right now*."],
  [65.6, 67.8, "We thought there had to be a better way."],
  [68.6, 70.6, "So we built *Borderless*."],
  [70.8, 73.4, "An autonomous household utilities agent."],
  [73.6, 76.8, "You set your household *budget*, *priorities* and spending permissions."],
  [77.0, 80.4, "Borderless monitors your utilities, predicts shortages,"],
  [80.4, 83.6, "discovers eligible services, evaluates options,"],
  [83.6, 86.6, "and makes purchases within the authority you've given it."],
  [86.8, 89.8, "You set the rules. *Borderless does the work.*"],
  [90.4, 93.6, "But here's where Borderless differs from *ordinary auto-pay*."],
  [93.8, 97.0, "Imagine you have just *2 USDC* of spending authority left."],
  [97.0, 99.4, "Your electricity is running low."],
  [99.4, 101.6, "Your mobile data is running low too."],
  [101.6, 104.6, "Both matter. But you can't afford both right now."],
  [104.6, 106.4, "What should happen?"],
  [106.6, 110.2, "Borderless weighs the household's *priorities*, urgency and eligible options."],
  [110.2, 113.6, "It prioritises *electricity* and defers the data purchase."],
  [113.6, 115.4, "And it explains why."],
  [115.6, 117.0, "That's the difference."],
  [117.0, 120.6, "Borderless isn't simply responding to a low balance."],
  [120.6, 125.8, "It's making a *purchasing decision* across competing needs, within rules you've approved."],
  [126.4, 128.4, "Here's how we've engineered it."],
  [128.6, 132.4, "First, the *household owner*: budget, priorities and spending permissions."],
  [132.6, 136.6, "The *agent* observes, forecasts shortages, discovers eligible providers"],
  [136.6, 139.4, "and evaluates what should be purchased."],
  [139.6, 143.0, "But one decision matters most: the agent does not control *financial authority*."],
  [143.2, 147.0, "Every intended purchase passes through an *independent policy engine*."],
  [147.0, 151.0, "It checks the provider, payment terms, limits, balance and whether approval is needed."],
  [151.2, 154.0, "Only then can the purchase reach the *x402* payment layer."],
  [154.2, 157.6, "The provider protects the resource behind *HTTP 402*."],
  [157.6, 161.6, "Borderless validates the terms; the facilitator verifies and *settles on Stellar*."],
  [161.8, 165.0, "Only after settlement does the provider *release* the resource."],
  [165.2, 169.8, "Finally, Borderless verifies fulfilment and records the whole lifecycle."],
  [176.4, 178.4, "Let's see Borderless execute a purchase."],
  [178.6, 181.0, "We simulate a low electricity balance."],
  [181.2, 185.0, "Borderless detects the shortage, checks its spending authority"],
  [185.0, 187.6, "and discovers an eligible electricity provider."],
  [187.8, 189.6, "It requests the purchase."],
  [189.8, 192.4, "The provider responds: *HTTP 402, Payment Required*."],
  [192.6, 196.6, "It won't release the protected resource until payment is *verified*."],
  [196.8, 199.6, "Borderless validates the terms against the household's permissions."],
  [199.8, 202.4, "It's within the authorised limit, so it proceeds."],
  [202.6, 206.6, "Using *x402 on Stellar*, it makes a real USDC payment on testnet."],
  [206.8, 209.8, "The provider verifies the settlement and *releases* the purchase."],
  [210.0, 214.0, "The simulated meter is credited. Borderless verifies fulfilment"],
  [214.0, 217.6, "and generates a *receipt*."],
  [218.4, 221.8, "Of course, giving an agent the ability to spend means giving it *boundaries*."],
  [222.0, 224.6, "Borderless has an *independent policy engine*."],
  [224.8, 227.4, "The agent cannot increase its own spending authority."],
  [227.6, 230.6, "Here, it attempts a purchase above the authorised limit."],
  [230.8, 233.6, "The system rejects it *before payment is signed*."],
  [233.8, 237.6, "Because autonomy should never mean *losing control*."],
  [238.4, 241.4, "We started with a problem most of us have experienced."],
  [241.6, 245.6, "But the bigger opportunity is how households reach *essential services*."],
  [245.8, 250.6, "Instead of watching balances and paying one by one, households can *delegate* to an agent they control."],
  [250.8, 254.6, "We started with *electricity*. The same system extends to airtime, data and more."],
  [254.8, 256.6, "This is Borderless."],
  [256.8, 263.2, "Your household stays powered and connected. *Borderless handles the rest.*"],
];
window.CAPTIONS = CAPTIONS;
window.DURATION = 264;

// ── render loop ───────────────────────────────────────────────────────────────
const stage = document.getElementById("stage");
const capWrap = document.getElementById("cap"), cap = capWrap.querySelector(".pill");
let built = false;
async function build() {
  await loadClips(["overview", "settings", "scenarioB", "scenarioA", "scenarioC", "explorer"]);
  for (const s of SCENES) {
    s.root = el("div", "scene", "", stage);
    s.update = s.build(s.root);
  }
  await document.fonts.ready;
  built = true;
}
window.renderAt = async (t) => {
  if (!built) await build();
  const pending = [];
  let dark = false;
  for (const s of SCENES) {
    const on = t >= s.start && t < s.end;
    s.root.style.display = on ? "block" : "none";
    if (!on) continue;
    const l = t - s.start;
    s.root.style.opacity = Math.min(fin(l, 0, 0.35), 1 - ease((l - (s.end - s.start - 0.35)) / 0.35));
    if (s.start === 0) s.root.style.opacity = 1;
    dark = s.dark;
    pending.push(s.update(l));
  }
  // Statement cards are dark: flip the caption style while one covers the frame.
  const darkCard = [[121, 126.2], [233.9, 238.2]].some(([a, b]) => t >= a && t < b);
  capWrap.classList.toggle("ondark", dark || darkCard);
  const c = CAPTIONS.find(([a, b]) => t >= a && t < b);
  if (c) { cap.innerHTML = fmt(c[2]); capWrap.style.opacity = Math.min(fin(t, c[0], 0.15), 1 - ease((t - (c[1] - 0.15)) / 0.15)); }
  else capWrap.style.opacity = 0;
  await Promise.all(pending);
  return true;
};
