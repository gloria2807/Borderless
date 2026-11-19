// ── The sub-3-minute cut (all times absolute, from video/studio/cut.json) ───────
const SCENES = [];
const scene = (start, end, dark, build) => SCENES.push({ start, end, dark, build });
let CUT = null;
const capT = (re) => CUT.captions.find((c) => re.test(c[2]))[0];

/** Real excerpts from the repository (abridged with "…"), lightly syntax-coloured. */
const CODE = {
  seller: {
    file: "src/server/providers/x402-seller.ts",
    title: "1 · The provider protects its endpoint",
    lines: [
      ["c", "// Each demo provider runs its own x402 resource server"],
      ["", "const resourceServer = new <k>x402ResourceServer</k>(createFacilitatorClient())"],
      ["", "  .register(e.STELLAR_NETWORK, new <k>ExactStellarScheme</k>());"],
      ["", "const server = new <k>x402HTTPResourceServer</k>(resourceServer, {"],
      ["", "  [<s>`POST ${paidPath}`</s>]: {"],
      ["", "    accepts: {"],
      ["", "      scheme: <s>\"exact\"</s>,"],
      ["", "      network: e.STELLAR_NETWORK, <c>// stellar:testnet</c>"],
      ["", "      payTo,                    <c>// provider's registered wallet</c>"],
      ["", "      price: … <c>// the provider's own quote, in test USDC</c>"],
      ["c", "// unpaid request → HTTP 402 + PAYMENT-REQUIRED"],
    ],
  },
  buyer: {
    file: "src/server/payments/x402-buyer.ts",
    title: "2 · Borderless pays, within policy",
    lines: [
      ["", "const core = new <k>x402Client</k>()"],
      ["", "  .register(<s>\"stellar:*\"</s>, new <k>ExactStellarScheme</k>(signer, …))"],
      ["", "  .registerPolicy((_v, reqs) => reqs.filter(expected));"],
      ["c", "// 3. Request the utility. Expect HTTP 402."],
      ["", "first = await doFetch(url, init());"],
      ["", "if (first.status !== <n>402</n>) throw …"],
      ["", "const finalCheck = <k>evaluateSpendingAuthority</k>(…);"],
      ["c", "// 4. Sign (server-side) — the model never holds the key"],
      ["", "payload = await http.<k>createPaymentPayload</k>(…);"],
      ["", "paid = await doFetch(url, init(http.<k>encodePaymentSignatureHeader</k>(payload)));"],
    ],
  },
  handler: {
    file: "src/server/providers/purchase-handler.ts",
    title: "3 · Released only after settlement",
    lines: [
      ["c", "// validate → 402 | verify → settle (on-chain) → release"],
      ["c", "// 3. Verify with the facilitator."],
      ["", "verified = await seller.<k>processHTTPRequest</k>(context);"],
      ["c", "// 4. Settle on Stellar testnet via the facilitator."],
      ["c", "//    Nothing has been released yet."],
      ["", "settled = await seller.<k>processSettlement</k>("],
      ["", "  verified.paymentPayload, verified.paymentRequirements, …);"],
      ["", "if (!settled.success || !settled.transaction) return …;"],
      ["c", "// 5. Record the unique tx hash, then release the"],
      ["c", "//    simulated utility and issue a receipt."],
    ],
  },
};
function codeCard(root, key, left) {
  const c = CODE[key];
  const html = c.lines.map(([cls, l]) => `<div class="${cls === "c" ? "cm" : ""}">${l.replace(/<k>/g, '<span class="kw">').replace(/<\/k>/g, "</span>").replace(/<s>/g, '<span class="st">').replace(/<\/s>/g, "</span>").replace(/<n>/g, '<span class="nu">').replace(/<\/n>/g, "</span>").replace(/<c>/g, '<span class="cm">').replace(/<\/c>/g, "</span>")}</div>`).join("");
  const d = el("div", "codecard", `<div class="ct">${c.title}</div><div class="cf">${c.file}</div><div class="code">${html}</div>`, root);
  d.style.left = left + "px";
  return d;
}

function defineScenes(cut) {
  CUT = cut;
  const K = cut.clips;
  const S = Object.fromEntries(cut.scenes.map((s) => [s.n, s]));
  const b1 = S[2].first - 0.6, b2 = S[3].first - 0.3, b3 = S[4].first - 0.3, b4 = S[5].first - 0.4, b5 = S[6].first - 0.35, b6 = S[7].first - 0.4, b7 = S[8].first - 0.4;

  // S1 — the shared experience.
  scene(0, b1, true, (root) => {
    root.classList.add("dark");
    const t1 = el("div", "abs", "We've all been here before.", root);
    css(t1, { left: "0", right: "0", top: "440px", textAlign: "center", fontSize: "74px", fontWeight: 700, letterSpacing: "-.04em" });
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
      </svg>`, root);
    css(room, { inset: "0" });
    const wave = room.querySelector("#wave");
    const meter = el("div", "abs", `
      <div style="width:520px;padding:22px;border-radius:26px;background:#151614;box-shadow:0 0 0 2px rgba(255,255,255,.18)">
        <div style="border-radius:14px;background:#dfe6d3;padding:22px 26px;color:#1b2615">
          <div class="mono" style="font-size:16px;letter-spacing:.14em;color:#4f5d43;display:flex;justify-content:space-between"><span>CREDIT</span><span id="nc" style="color:#b8392a">NO CREDIT</span></div>
          <div class="mono" style="font-size:96px;text-align:right;line-height:1.05;margin-top:8px">0.0<span style="font-size:30px;color:#4f5d43"> kWh</span></div>
          <div class="mono" style="font-size:15px;color:#4f5d43;margin-top:6px">PREPAID METER</div>
        </div>
      </div>`, root);
    css(meter, { left: "700px", top: "330px" });
    const nc = meter.querySelector("#nc");
    const note = el("div", "abs", `<div style="width:620px;border-radius:24px;background:rgba(251,250,247,.96);color:#0c0d0c;padding:20px 24px;box-shadow:0 24px 60px -20px rgba(0,0,0,.6)">
        <div style="display:flex;justify-content:space-between;font-size:17px;color:#4a4e49"><b style="color:#0c0d0c">MTN</b><span>now</span></div>
        <div style="font-size:26px;font-weight:600;margin-top:8px">Your data balance is 50MB.</div></div>`, root);
    css(note, { left: "650px", top: "200px" });
    const end = el("div", "abs", `<div id="e1" style="font-size:84px;font-weight:700;letter-spacing:-.045em;line-height:1.05"><span>Electricity.</span> <span>Airtime.</span> <span>Data.</span></div>
      <div id="e2" style="margin-top:22px;font-size:46px;font-weight:600;letter-spacing:-.03em;color:rgba(255,255,255,.7)">Different services. <span style="color:var(--green-bright)">One household budget.</span></div>`, root);
    css(end, { left: "160px", top: "400px" });
    const words = end.querySelectorAll("#e1 span"), e2 = end.querySelector("#e2");
    const lightsOut = K.c2.at + 0.95;
    return (t) => {
      show(t1, vis(t, 0.3, 2.0, 0.35), 14);
      const on = t >= 1.8 && t < lightsOut;
      css(room, { opacity: on ? fin(t, 1.8, 0.6) : 0, visibility: on ? "visible" : "hidden" });
      wave.innerHTML = Array.from({ length: 14 }, (_, i) => { const h = 6 + 18 * Math.abs(Math.sin(t * 6 + i * 0.9)); return `<rect x="${820 + i * 20}" y="${650 - h / 2}" width="8" height="${h}" rx="4" fill="rgba(143,216,176,.75)"/>`; }).join("");
      show(meter, vis(t, K.c3.at, 14.6), 20);
      nc.style.opacity = Math.floor(t * 2) % 2 ? 1 : 0.25;
      show(note, vis(t, 14.8, 18.8), -30);
      const et = capT(/between the two/);
      words.forEach((w, i) => show(w, fin(t, et + i * 0.5, 0.4), 12));
      show(e2, fin(t, et + 1.8, 0.5), 12);
      css(end, { opacity: t >= et ? 1 : 0 });
    };
  });

  // S2 — the insight: competing needs, one budget.
  scene(b1, b2, false, (root) => {
    root.classList.add("light", "grid");
    const g = el("div", "abs", `
      <div class="label" style="position:absolute;left:0;right:0;top:150px;text-align:center;color:var(--green)">Competing household needs</div>
      ${[["Electricity", "Runs out in 25 h", "#b8392a", 520], ["Airtime", "8 days left", "#0a6577", 840], ["Mobile data", "Runs out in 27 h", "#8f5b00", 1160]].map(([n, s, c, x]) => `
        <div class="card need" style="position:absolute;left:${x}px;top:250px;width:240px;padding:22px 24px"><div style="width:12px;height:12px;border-radius:50%;background:${c}"></div>
        <div style="margin-top:12px;font-size:28px;font-weight:700;letter-spacing:-.02em">${n}</div><div style="margin-top:4px;font-size:18px;color:var(--fg3)">${s}</div></div>`).join("")}
      <svg width="1920" height="1080" style="position:absolute;inset:0"><g id="lines" stroke="#5f635c" stroke-width="2.5" stroke-dasharray="8 7" fill="none">
        <path d="M640 400 C640 480 960 470 960 560"/><path d="M960 400 L960 560"/><path d="M1280 400 C1280 480 960 470 960 560"/></g></svg>
      <div id="budget" style="position:absolute;left:760px;top:570px;width:400px;height:96px;border-radius:99px;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:700;letter-spacing:-.02em">One household budget</div>
      <div id="q" style="position:absolute;left:0;right:0;top:730px;text-align:center;font-size:40px;font-weight:700;letter-spacing:-.03em">Which need matters more <span style="color:var(--green)">right now?</span></div>`, root);
    css(g, { inset: "0" });
    const needs = g.querySelectorAll(".need"), lines = g.querySelector("#lines"), budget = g.querySelector("#budget"), q = g.querySelector("#q");
    return (t) => {
      needs.forEach((n, i) => show(n, fin(t, b1 + 0.4 + i * 0.35, 0.5), 16));
      lines.style.opacity = fin(t, b1 + 1.6, 0.6);
      lines.style.strokeDashoffset = -t * 30;
      show(budget, fin(t, b1 + 2.0, 0.5), 16);
      show(q, fin(t, capT(/matters more right now/) + 1.0, 0.5), 12);
    };
  });

  // S3 — introducing Borderless; the owner sets the rules.
  scene(b2, b3, false, (root) => {
    root.classList.add("light", "grid");
    const logo = el("div", "abs", `<div style="display:flex;align-items:center;justify-content:center;gap:22px"><span style="width:96px;height:96px;color:var(--green);display:block">${BRAND}</span><span style="font-size:120px;font-weight:700;letter-spacing:-.05em">Borderless</span></div>
      <div style="margin-top:22px;text-align:center;font-size:34px;color:var(--fg2)">An autonomous household utilities agent.</div>`, root);
    css(logo, { left: "0", right: "0", top: "380px" });
    const ws = K.c8.at - 0.2;
    const win = makeWindow(root, [{ a: ws, b: b3, clip: "settings", from: 5.6, speed: 1, zoom: [[0, 1, 640, 400], [2.0, 1.18, 560, 330]] }]);
    const side = makeSide(root, { eyebrow: "01 · You set the rules", heading: "You set the rules.", items: [
      { at: ws + 1.0, text: "Automatic purchases up to <b>2 USDC</b>" },
      { at: ws + 2.0, text: "Owner approval <b>above 2 USDC</b>", cls: "amber" },
      { at: ws + 3.0, text: "<b>4 USDC</b> per task · <b>10 USDC</b> per day", cls: "cyan" },
      { at: K.c9.at, text: "Borderless <b>does the work</b>, within them", cls: "ink" },
    ] });
    const sideEl = root.querySelector(".side");
    return (t) => {
      show(logo, vis(t, b2 + 0.1, ws, 0.4), 18);
      const a = vis(t, ws, b3 + 1, 0.4);
      css(win.el, { opacity: a, visibility: a > 0 ? "visible" : "hidden" }); sideEl.style.opacity = a;
      side.update(t, ws + 0.3);
      return a > 0 ? win.update(t) : undefined;
    };
  });

  // S4 — the 2 USDC decision (Scenario B, live).
  scene(b3, b4, false, (root) => {
    root.classList.add("light", "grid");
    const w0 = K.c11.at - 0.1, run0 = K.c13.at, sum0 = capT(/And it explains why/) - 0.2;
    const win = makeWindow(root, [
      { a: w0, b: K.c12.at, clip: "scenarioB", from: 0.8, speed: 0.48, noCursor: true, zoom: [[0, 1, 640, 400], [1.0, 1.5, 520, 250], [4.4, 1.5, 520, 250], [5.6, 1.28, 480, 95], [9.4, 1.28, 480, 95]], hl: { from: 1.4, to: 4.6, x: 437, y: 207, w: 182, h: 92 } },
      { a: K.c12.at, b: run0, clip: "scenarioB", from: 5.4, speed: 1 },
      { a: run0, b: sum0, clip: "scenarioB", from: 8.6, speed: 1.45, badge: "1.45× · live run" },
      { a: sum0, b: b4, clip: "scenarioB", from: 22.0, speed: 1, zoom: [[0, 1, 640, 400], [0.8, 1.42, 560, 420]] },
    ]);
    const side = makeSide(root, { eyebrow: "02 · The differentiator", heading: "*2 USDC.* Two competing needs. One decision.", items: [
      { at: w0 + 1.4, text: "<b>2.00 USDC</b> of authority left", cls: "amber" },
      { at: capT(/electricity is running low/), text: "Electricity: about <b>25 h</b> left", cls: "coral" },
      { at: capT(/mobile data is running low/), text: "Mobile data: about <b>27 h</b> left", cls: "coral" },
      { at: capT(/weighs the household/), text: "Owner's priority: <b>electricity first</b>", cls: "ink" },
      { at: capT(/prioritises/), text: "Bought <b>2.00 USDC</b> of electricity" },
      { at: capT(/explains why/), text: "Deferred data, <b>and said why</b>", cls: "cyan" },
    ] });
    const sideEl = root.querySelector(".side");
    const st = makeStatement(root, [["Auto-pay follows instructions.", 0], ["Borderless makes *purchasing decisions.*", 1.0]]);
    return (t) => {
      st.update(t, b3, w0 + 0.15);
      const a = t >= w0 - 0.2 ? 1 : 0;
      win.el.style.opacity = a; sideEl.style.opacity = a;
      side.update(t, w0 + 0.3);
      return a ? win.update(t) : undefined;
    };
  });

  // S5 — architecture, then where x402 lives in the code.
  scene(b4, b5, false, (root) => {
    root.classList.add("light", "grid");
    const head = el("div", "abs", `<div class="label" style="color:var(--green)">03 · How it works — from the repository</div>
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
    const boxes = L.map(([n, h, p, f], i) => { const bx = el("div", "layer" + (i === 2 ? " policy" : ""), `<div class="n">${n}</div><h3>${h}</h3><p>${p}</p><div class="f">${f}</div>`, root); bx.style.left = X(i) + "px"; return bx; });
    const arrows = [0, 1, 2, 3, 4].map((i) => { const a = el("div", "arrow", "", root); css(a, { left: X(i) + 268 + 6 + "px", width: "32px" }); return a; });
    const guard = el("div", "abs", `<div style="width:268px;padding:12px 14px;border-radius:12px;background:#f8ebcf;font-size:14.5px;line-height:1.4;color:#5c3b00"><b>Code, not the model.</b> The agent can't raise its own authority or approve itself.</div>`, root);
    css(guard, { left: X(2) + "px", top: "648px" });
    const planner = el("div", "abs", `<div style="width:268px;padding:12px 14px;border-radius:12px;background:var(--bg2);font-size:14.5px;line-height:1.4;color:var(--fg2)"><b style="color:var(--ink)">AI or deterministic planner.</b> Same tools, same rules. This recording: deterministic.</div>`, root);
    css(planner, { left: X(1) + "px", top: "648px" });
    const p0 = K.c15.at, x402 = capT(/reach the \*x402\*/), code0 = capT(/behind \*HTTP 402\*/) - 0.3;
    const reveal = [p0 + 0.2, p0 + 1.2, capT(/independent policy engine/), x402, x402 + 1.0, x402 + 2.0];
    // Where x402 lives: three real excerpts.
    const codeHead = el("div", "abs", `<div class="label" style="color:var(--green)">Real code from the repository · @x402/core + @x402/stellar</div>
      <div style="margin-top:14px;font-size:48px;font-weight:700;letter-spacing:-.04em">Where <span style="color:var(--green)">x402 on Stellar</span> lives in Borderless</div>`, root);
    css(codeHead, { left: "46px", top: "96px" });
    const flow = el("div", "abs", ["Agent", "Policy engine", "x402 buyer", "HTTP 402 → signed", "Facilitator · Stellar testnet", "Provider releases"].map((s, i) => `<span class="chip" style="background:${i === 3 || i === 4 ? "var(--ink)" : "var(--surface)"};color:${i === 3 || i === 4 ? "#fff" : "var(--fg2)"};box-shadow:var(--ring);font-size:16px;height:34px">${s}</span>${i < 5 ? '<span style="color:var(--fg3);margin:0 8px">→</span>' : ""}`).join(""), root);
    css(flow, { left: "46px", top: "232px", display: "flex", alignItems: "center" });
    const cards = [codeCard(root, "seller", 46), codeCard(root, "buyer", 666), codeCard(root, "handler", 1286)];
    const cardAt = [code0, capT(/validates the terms; the facilitator/), capT(/Only after settlement/)];
    return (t) => {
      const diag = vis(t, b4, code0, 0.4), code = vis(t, code0 - 0.05, b5 + 1, 0.4);
      show(head, Math.min(diag, fin(t, b4 + 0.1, 0.5)), 14);
      boxes.forEach((bx, i) => show(bx, Math.min(diag, fin(t, reveal[i], 0.5)), 22));
      arrows.forEach((a, i) => { a.style.opacity = Math.min(diag, fin(t, reveal[i + 1] - 0.2, 0.4)); });
      boxes.forEach((bx, j) => bx.classList.toggle("lit", (j === 2 && t >= reveal[2] && t < x402) || (j === 3 && t >= x402)));
      show(guard, Math.min(diag, fin(t, capT(/does not control/) + 1.5, 0.5)), 10);
      show(planner, Math.min(diag, fin(t, p0 + 1.6, 0.5)), 10);
      show(codeHead, Math.min(code, fin(t, code0, 0.5)), 12);
      show(flow, Math.min(code, fin(t, code0 + 0.2, 0.5)), 10);
      cards.forEach((c, i) => { show(c, Math.min(code, fin(t, cardAt[i] - 0.1, 0.5)), 24); c.classList.toggle("focus", t >= cardAt[i] && t < (cardAt[i + 1] ?? 1e9)); });
    };
  });

  // S6 — the live electricity purchase (Scenario A).
  scene(b5, b6, false, (root) => {
    root.classList.add("light", "grid");
    const c402 = capT(/responds: \*HTTP 402/), cWont = capT(/won't release/), cVal = capT(/validates the terms against/), cPay = capT(/Using \*x402 on Stellar/), cRel = capT(/verifies the settlement/), cMeter = capT(/simulated meter is credited/), cRcpt = capT(/generates a \*receipt/);
    const exp0 = cRel + 2.7;
    const win = makeWindow(root, [
      { a: b5, b: K.c20.at, clip: "scenarioA", from: 4.95 - (K.c20.at - b5), speed: 1 },
      { a: K.c20.at, b: K.c21.at, clip: "scenarioA", from: 5.1, speed: 0.1, badge: "0.1× · slowed to show each step" },
      { a: K.c21.at, b: c402, clip: "scenarioA", from: 5.85, speed: 0.2, badge: "0.2× · slowed" },
      { a: c402, b: cWont, clip: "scenarioA", from: 29.9, speed: 1, zoom: [[0, 1, 640, 400], [0.8, 1.55, 560, 190]] },
      { a: cWont, b: cVal, clip: "scenarioA", from: 47.6, speed: 0.8, zoom: [[0, 1.1, 640, 300], [0.8, 1.45, 520, 290]] },
      { a: cVal, b: cPay, clip: "scenarioA", from: 35.6, speed: 0.5, zoom: [[0, 1.12, 640, 240], [1.0, 1.32, 600, 230]] },
      { a: cPay, b: cRel, clip: "scenarioA", from: 6.6, speed: 1, badge: "1× · live run, real time" },
      { a: cRel, b: exp0, clip: "scenarioA", from: 16.0, speed: 1, badge: "1× · live · settlement wait shortened" },
      { a: exp0, b: cMeter + 1.8, clip: "explorer", from: 0.4, speed: 1, zoom: [[0, 1, 640, 400], [1.0, 1.25, 560, 330]] },
      { a: cMeter + 1.8, b: cRcpt, clip: "scenarioA", from: 59.0, speed: 1, zoom: [[0, 1.0, 640, 400], [1.0, 1.3, 400, 300]] },
      { a: cRcpt, b: b6 + 1, clip: "scenarioA", from: 53.8, speed: 1, zoom: [[0, 1.12, 700, 380]] },
    ]);
    const side = makeSide(root, { eyebrow: "04 · Live on Stellar testnet", heading: "One electricity purchase, end to end.", items: [
      { step: true, at: b5, done: K.c19.end - 0.4, text: "Low balance simulated" },
      { step: true, at: K.c20.at, done: K.c20.at + 2.4, text: "Shortage detected" },
      { step: true, at: K.c20.at + 2.4, done: K.c20.at + 4.6, text: "Spending authority checked" },
      { step: true, at: K.c20.at + 4.6, done: K.c21.at, text: "Eligible provider discovered" },
      { step: true, at: K.c21.at, done: c402, text: "Purchase requested: 2 USDC" },
      { step: true, at: c402, done: cWont, text: "Provider answers <b>HTTP 402</b>" },
      { step: true, at: cVal, done: cPay, text: "Policy checks pass, before signing" },
      { step: true, at: cPay, done: cRel, text: "Signed · <b>settled on Stellar</b>" },
      { step: true, at: cRel, done: cMeter, text: "Provider verified · units released" },
      { step: true, at: cMeter, done: cRcpt + 0.8, text: "Meter credited · receipt issued" },
    ] });
    const proof = el("div", "proof", `<div class="k">Real settlement · verified on Horizon</div><div class="h">${(window.TX || "").slice(0, 10)}…${(window.TX || "").slice(-8)}</div>
      <div class="r">Ledger 5,780,559 · <b style="color:#fff">2.0000000 USDC</b><br>GAT3…XCJV (agent) → GDTQ…A3JC (provider payee)</div>`, root);
    const n1 = el("div", "note", "Real Stellar testnet settlement — test USDC, no monetary value.", root);
    css(n1, { left: "72px", top: "905px" });
    const n2 = el("div", "note", "Simulated utility provider and virtual meter.", root);
    css(n2, { left: "860px", top: "905px" });
    return (t) => {
      side.update(t, b5 + 0.3);
      show(proof, vis(t, exp0 + 0.5, cMeter + 1.8, 0.4), 14);
      n1.style.opacity = fin(t, b5 + 0.6, 0.5); n2.style.opacity = fin(t, b5 + 0.6, 0.5);
      return win.update(t);
    };
  });

  // S7 — trust: refused before signing (Scenario C).
  scene(b6, b7, false, (root) => {
    root.classList.add("light", "grid");
    const rej = K.c27.at, stmt = K.c28.at - 0.15;
    const win = makeWindow(root, [
      { a: b6, b: rej, clip: "scenarioC", from: 7.9 - (rej - b6), speed: 1 },
      { a: rej, b: stmt, clip: "scenarioC", from: 9.6, speed: 1, zoom: [[0, 1, 640, 400], [0.8, 1.45, 600, 330]], badge: "1× · live run" },
    ]);
    const side = makeSide(root, { eyebrow: "05 · Trust", heading: "Autonomy, *within limits.*", items: [
      { at: K.c26.at + 0.6, text: "Instructed: buy <b>5.00 USDC</b> of electricity", cls: "amber" },
      { at: K.c26.at + 2.0, text: "Owner's maximum: <b>4.00 USDC</b> per request", cls: "ink" },
      { at: rej + 0.4, text: "<b>Refused before signing</b>", cls: "coral" },
      { at: rej + 1.4, text: "No payment. No settlement.", cls: "coral" },
    ] });
    const st = makeStatement(root, [["The AI proposes.", 0], ["The code *enforces.*", 0.6]], { size: 96 });
    return (t) => {
      side.update(t, b6 + 0.3);
      st.update(t, stmt, b7 + 0.2);
      return t < stmt + 0.5 ? win.update(t) : undefined;
    };
  });

  // S8 — the bigger possibility, and close.
  scene(b7, cut.duration + 1, false, (root) => {
    root.classList.add("light", "grid");
    const endAt = K.c30.at - 0.2;
    const win = makeWindow(root, [{ a: b7, b: endAt + 0.5, clip: "overview", from: 7.0, speed: 1 }]);
    const side = makeSide(root, { eyebrow: "06 · What's next", heading: "Electricity first. *Every household service* next.", items: [
      { at: b7 + 1.0, text: "Electricity: <b>live today</b>" },
      { at: b7 + 2.6, text: "Airtime and data: <b>same agent, same rules</b>", cls: "cyan" },
      { at: b7 + 4.0, text: "Any service sold <b>per request</b>", cls: "ink" },
    ] });
    const sideEl = root.querySelector(".side");
    const fin2 = el("div", "abs", `<div style="display:flex;align-items:center;justify-content:center;gap:22px"><span style="width:92px;height:92px;color:var(--green);display:block">${BRAND}</span><span style="font-size:126px;font-weight:800;letter-spacing:-.05em">BORDERLESS</span></div>
      <div style="margin-top:18px;text-align:center;font-size:36px;font-weight:600;letter-spacing:-.02em">Autonomous Household Utilities Agent</div>
      <div style="margin-top:14px;text-align:center;font-size:30px;color:var(--fg2)">You set the rules. <b style="color:var(--green)">Your agent handles the rest.</b></div>
      <div id="by" style="margin-top:40px;text-align:center;font-size:22px;color:var(--fg2)">Made by <b style="color:var(--ink)">Gloria</b> and <b style="color:var(--ink)">Hannah</b></div>
      <div class="label" style="margin-top:18px;text-align:center;color:var(--fg3)">teamborderless.vercel.app · x402 on Stellar testnet</div>`, root);
    css(fin2, { left: "0", right: "0", top: "300px" });
    const by = fin2.querySelector("#by");
    return (t) => {
      const a = vis(t, b7, endAt + 0.4, 0.4);
      css(win.el, { opacity: a, visibility: a > 0 ? "visible" : "hidden" }); sideEl.style.opacity = a;
      side.update(t, b7 + 0.3);
      show(fin2, fin(t, endAt + 0.2, 0.7), 18);
      show(by, fin(t, capT(/Made by Gloria/) - 0.1, 0.5), 8);
      return a > 0 ? win.update(t) : undefined;
    };
  });
}

// ── render loop (absolute time) ───────────────────────────────────────────────
const stage = document.getElementById("stage");
const capWrap = document.getElementById("cap"), cap = capWrap.querySelector(".pill");
let built = false, DARK_CARDS = [];
async function build() {
  const cut = await (await fetch("/cut.json")).json();
  window.DURATION = cut.duration;
  window.CAPTIONS = cut.captions;
  await loadClips(["overview", "settings", "scenarioB", "scenarioA", "scenarioC", "explorer"]);
  defineScenes(cut);
  const S = Object.fromEntries(cut.scenes.map((s) => [s.n, s]));
  DARK_CARDS = [[S[4].first - 0.3, cut.clips.c11.at + 0.05], [cut.clips.c28.at - 0.15, S[8].first - 0.2]];
  for (const s of SCENES) { s.root = el("div", "scene", "", stage); s.update = s.build(s.root); }
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
    s.root.style.opacity = s.start === 0 ? 1 : Math.min(fin(t, s.start, 0.3), 1 - ease((t - (s.end - 0.3)) / 0.3));
    dark = s.dark;
    pending.push(s.update(t));
  }
  capWrap.classList.toggle("ondark", dark || DARK_CARDS.some(([a, b]) => t >= a && t < b));
  const c = window.CAPTIONS.find(([a, b]) => t >= a && t < b);
  if (c) { cap.innerHTML = fmt(c[2]); capWrap.style.opacity = Math.min(fin(t, c[0], 0.12), 1 - ease((t - (c[1] - 0.12)) / 0.12)); }
  else capWrap.style.opacity = 0;
  await Promise.all(pending);
  return true;
};
