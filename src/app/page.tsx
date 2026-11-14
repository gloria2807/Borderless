import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, BatteryCharging, Check, FlaskConical, Phone, ShieldCheck, Wifi } from "lucide-react";
import { BrandMark } from "@/components/shell/nav";
import { cn } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: { absolute: "Borderless — an autonomous household procurement agent" },
  description: "Borderless keeps a household's electricity, airtime and data running, and pays machine-accessible providers itself through x402 on Stellar testnet.",
};

const STEPS = [
  { n: "01", title: "Observe", body: "Reads the prepaid meter and phone line, and forecasts how long each will last at the current rate." },
  { n: "02", title: "Identify a need", body: "Decides what actually needs buying now and what can wait. Buying nothing is a valid outcome." },
  { n: "03", title: "Discover", body: "Fetches providers' published service documents over HTTP and verifies each against its own registry." },
  { n: "04", title: "Evaluate", body: "Compares offers, and decides whether a paid diagnostic is worth buying before buying the utility." },
  { n: "05", title: "Authorise", body: "Ordered spending checks in code, before anything is signed. Larger purchases wait for your approval." },
  { n: "06", title: "Pay", body: "The provider answers HTTP 402. Borderless signs, and the payment settles on Stellar testnet." },
  { n: "07", title: "Receive and act", body: "The provider releases credit or a report only after settlement. Borderless verifies it and reassesses." },
];

const REAL = [
  "x402 payments: providers answer HTTP 402 and release nothing until a payment settles",
  "Settlement on Stellar testnet in testnet USDC, with transaction links you can open",
  "The spending rules, approvals bound to exact terms, and their expiry",
  "Every agent step, recorded on the server and streamed live as it happens",
];
const SIMULATED = [
  "Electricity, airtime and data, and the meter and phone that hold them",
  "The providers: clearly labelled demo services, with their own registered wallets",
  "The meter telemetry that a paid diagnostic reads",
  "Household time, which you can move forward from the demo controls",
];

function Sources() {
  const items = [
    { icon: BatteryCharging, label: "Prepaid meter", meta: "8.0 kWh" },
    { icon: Phone, label: "Airtime line", meta: "₦200" },
    { icon: Wifi, label: "Mobile data", meta: "150 MB" },
  ];
  return (
    <ul className="space-y-2.5">
      {items.map(({ icon: Icon, label, meta }) => (
        <li key={label} className="flex items-center gap-2.5 rounded-lg bg-raised px-3 py-2.5 shadow-ring">
          <span className="flex size-7 items-center justify-center rounded-md bg-bg-2">
            <Icon className="size-3.5 text-fg-2" aria-hidden />
          </span>
          <span className="text-[12.5px] font-medium text-fg">{label}</span>
          <span className="mono ml-auto text-[10.5px] text-fg-3">{meta}</span>
        </li>
      ))}
    </ul>
  );
}

/** Sources → agent → paid providers. Illustrative; the live product is one click away. */
function Diagram() {
  return (
    <figure className="relative rounded-2xl bg-surface/80 p-4 shadow-ring backdrop-blur-sm sm:p-6" aria-label="How Borderless works: household devices feed the agent, which pays providers through x402">
      <div className="grid items-center gap-4 md:grid-cols-[1fr_auto_1.15fr_auto_1fr]">
        <div>
          <p className="label mb-2.5">Household · simulated</p>
          <Sources />
        </div>

        <div aria-hidden className="hidden h-px w-10 border-t border-dashed border-fg/25 md:block" />

        <div className="rounded-xl bg-ink p-4 text-white shadow-[0_18px_40px_-18px_rgb(12_13_12/0.6)]">
          <div className="flex items-center gap-2">
            <BrandMark className="size-4 text-green-bright" />
            <span className="text-[13px] font-semibold">Borderless agent</span>
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-[10.5px] text-white/80">
              <span className="size-1.5 animate-pulse-dot rounded-full bg-green-bright" /> Running
            </span>
          </div>
          <ol className="mt-3.5 space-y-1.5 text-[12px]">
            {["Mobile data runs out in ~7 h", "2 data providers found and verified", "Spending rules: allowed", "HTTP 402 → signed → settled"].map((t, i) => (
              <li key={t} className="flex items-center gap-2 text-white/80">
                <span className={cn("flex size-4 items-center justify-center rounded-full", i < 3 ? "bg-green-bright text-ink" : "bg-white/15")}>
                  {i < 3 ? <Check className="size-2.5" strokeWidth={3} aria-hidden /> : <span className="size-1 rounded-full bg-white" />}
                </span>
                {t}
              </li>
            ))}
          </ol>
          <p className="mono mt-3.5 border-t border-white/10 pt-2.5 text-[10px] tracking-[0.08em] text-white/65 uppercase">Illustration · see the live run in the demo</p>
        </div>

        <div aria-hidden className="hidden h-px w-10 border-t border-dashed border-fg/25 md:block" />

        <div>
          <p className="label mb-2.5">Providers · paid per request</p>
          <ul className="space-y-2.5">
            {[
              { name: "Data provider", what: "4 GB bundle", tag: "x402" },
              { name: "Electricity vendor", what: "kWh credit", tag: "x402" },
              { name: "Meter diagnostics", what: "Report", tag: "x402" },
            ].map((p) => (
              <li key={p.name} className="flex items-center gap-2.5 rounded-lg bg-raised px-3 py-2.5 shadow-ring">
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium text-fg">{p.name}</span>
                  <span className="block text-[11px] text-fg-3">{p.what}</span>
                </span>
                <span className="ml-auto rounded-full bg-amber-soft px-2 py-px text-[10.5px] font-medium text-amber">Paid · {p.tag}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </figure>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-40 border-b border-line-soft bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1180px] items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2" aria-label="Borderless home">
            <BrandMark className="size-[18px] text-green" />
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Borderless</span>
          </Link>
          <nav aria-label="Sections" className="hidden items-center gap-5 text-[13px] text-fg-2 md:flex">
            <a href="#how" className="hover:text-fg">How it buys</a>
            <a href="#proof" className="hover:text-fg">Why payment matters</a>
            <a href="#control" className="hover:text-fg">Your control</a>
            <a href="#honest" className="hover:text-fg">What&apos;s real</a>
          </nav>
          <Link href="/overview" className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-white transition-colors hover:bg-ink-2">
            Open the demo <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="grid-paper relative overflow-hidden border-b border-line-soft">
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_30%,var(--color-bg)_75%)]" />
          <div className="relative mx-auto max-w-[1180px] px-4 pt-16 pb-16 sm:px-6 sm:pt-24 sm:pb-20">
            <p className="inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-[12px] font-medium text-fg-2 shadow-ring">
              <span className="size-1.5 rounded-full bg-cyan" aria-hidden />
              x402 payments on Stellar testnet
            </p>
            <h1 className="mt-6 max-w-4xl text-[40px] leading-[1.05] font-semibold tracking-[-0.045em] sm:text-[64px]">
              <span className="text-fg-3">Your household stays powered and connected.</span> Borderless handles the rest.
            </h1>
            <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-fg-2">
              An autonomous agent that keeps electricity, airtime and mobile data running. It works out what the household needs, finds providers, decides what is worth buying, and pays
              each one itself — within the spending rules you set.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/overview" className="inline-flex h-11 items-center gap-2 rounded-full bg-green px-5 text-[14px] font-medium text-white transition-colors hover:bg-green-hover">
                Open the live demo <ArrowRight className="size-4" aria-hidden />
              </Link>
              <a href="#how" className="inline-flex h-11 items-center rounded-full bg-surface px-5 text-[14px] font-medium text-fg shadow-ring transition-colors hover:bg-raised">
                See how it buys
              </a>
            </div>
            <div className="mt-14">
              <Diagram />
            </div>
          </div>
        </section>

        {/* How */}
        <section id="how" className="scroll-mt-14 border-b border-line-soft">
          <div className="mx-auto max-w-[1180px] px-4 py-20 sm:px-6">
            <p className="label">How a purchase works</p>
            <h2 className="mt-3 max-w-2xl text-[32px] leading-tight font-semibold tracking-[-0.035em]">
              From a forecast to a settled payment, <span className="text-fg-3">every step on the record.</span>
            </h2>
            <ol className="mt-10 grid gap-px overflow-hidden rounded-xl bg-fg/[0.07] shadow-ring sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s) => (
                <li key={s.n} className="bg-surface p-5">
                  <span className="mono text-[11px] text-fg-3">{s.n}</span>
                  <h3 className="mt-3 text-[15px] font-semibold tracking-[-0.01em]">{s.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-fg-2">{s.body}</p>
                </li>
              ))}
              <li className="flex flex-col justify-between bg-bg-2 p-5">
                <span className="mono text-[11px] text-fg-3">Then</span>
                <p className="mt-3 text-[13px] leading-relaxed text-fg-2">Open any purchase to inspect each of these steps from recorded data, with gaps marked as gaps.</p>
                <Link href="/transactions" className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-fg hover:underline">
                  Transactions <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </li>
            </ol>
          </div>
        </section>

        {/* Proof: dark band */}
        <section id="proof" className="scroll-mt-14 bg-ink text-white">
          <div className="mx-auto grid max-w-[1180px] gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:items-center">
            <div>
              <p className="label text-white/65">Why payment matters</p>
              <h2 className="mt-3 text-[32px] leading-tight font-semibold tracking-[-0.035em]">
                Remove the payment and Borderless stops working.
              </h2>
              <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-white/70">
                Utility credit and paid information are released only by the providers&apos; x402-protected endpoints, after a payment settles. There is no account, checkout or free path
                to fall back on. Every purchase page has a <span className="text-white">Request without paying</span> button that sends the same request with no payment, live, so you can
                see the provider refuse.
              </p>
              <ul className="mt-6 space-y-2 text-[13.5px] text-white/80">
                {["Discovery and quotes are free; the resource is not", "One settlement per payment, verified before release", "A paid 0.30 USDC meter diagnostic can change what gets bought next"].map((t) => (
                  <li key={t} className="flex gap-2.5">
                    <Check className="mt-0.5 size-4 shrink-0 text-green-bright" aria-hidden />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <figure className="overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/10">
              <figcaption className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                <span className="mono text-[11px] text-white/60">POST /api/services/…/meter-diagnostic</span>
                <span className="mono text-[10px] tracking-[0.08em] text-white/60 uppercase">Response shape</span>
              </figcaption>
              <pre className="mono overflow-x-auto p-4 text-[12px] leading-relaxed text-white/75">
                <span className="text-amber-bright">HTTP/1.1 402 Payment Required</span>
                {"\n"}PAYMENT-REQUIRED: {"{"}
                {"\n"}  &quot;x402Version&quot;: 2,
                {"\n"}  &quot;accepts&quot;: [{"{"}
                {"\n"}    &quot;scheme&quot;: &quot;exact&quot;,
                {"\n"}    &quot;network&quot;: <span className="text-green-bright">&quot;stellar:testnet&quot;</span>,
                {"\n"}    &quot;asset&quot;: &quot;USDC (testnet)&quot;,
                {"\n"}    &quot;amount&quot;: &quot;3000000&quot;, <span className="text-white/60">{"// 0.30 USDC"}</span>
                {"\n"}    &quot;payTo&quot;: &quot;&lt;provider&apos;s registered wallet&gt;&quot;
                {"\n"}  {"}"}]
                {"\n"}{"}"}
                {"\n"}
                {"\n"}<span className="text-white/60">{"// Nothing is released. Pay, settle, then ask again."}</span>
              </pre>
            </figure>
          </div>
        </section>

        {/* Control */}
        <section id="control" className="scroll-mt-14 border-b border-line-soft">
          <div className="mx-auto max-w-[1180px] px-4 py-20 sm:px-6">
            <p className="label">Your control</p>
            <h2 className="mt-3 max-w-2xl text-[32px] leading-tight font-semibold tracking-[-0.035em]">
              The agent proposes. <span className="text-fg-3">Fixed code decides what money may move.</span>
            </h2>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {[
                { title: "Limits it cannot exceed", body: "Per purchase, per day, per run and per period, plus a cap on information purchases. Checked again just before signing." },
                { title: "Approval for larger buys", body: "Above your threshold, nothing is paid until you approve the exact amount, payee and recipient. Requests expire unpaid." },
                { title: "An off switch", body: "Turn automatic purchasing off and Borderless keeps watching and recommending, but spends nothing." },
              ].map((c) => (
                <div key={c.title} className="rounded-xl bg-surface p-5 shadow-ring">
                  <span className="flex size-8 items-center justify-center rounded-full bg-green-soft">
                    <ShieldCheck className="size-4 text-green" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-[15px] font-semibold tracking-[-0.01em]">{c.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-fg-2">{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Honesty */}
        <section id="honest" className="scroll-mt-14 border-b border-line-soft bg-bg-2/60">
          <div className="mx-auto max-w-[1180px] px-4 py-20 sm:px-6">
            <p className="label">What&apos;s real, what&apos;s simulated</p>
            <h2 className="mt-3 max-w-2xl text-[32px] leading-tight font-semibold tracking-[-0.035em]">A demo that says exactly what it proves.</h2>
            <div className="mt-10 grid gap-px overflow-hidden rounded-xl bg-fg/[0.07] shadow-ring md:grid-cols-2">
              <div className="bg-surface p-6">
                <p className="flex items-center gap-2 text-[13px] font-semibold">
                  <span className="size-2 rounded-full bg-green" aria-hidden /> Real
                </p>
                <ul className="mt-4 space-y-2.5 text-[13.5px] text-fg-2">
                  {REAL.map((t) => (
                    <li key={t} className="flex gap-2.5">
                      <Check className="mt-0.5 size-4 shrink-0 text-green" aria-hidden />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-surface p-6">
                <p className="flex items-center gap-2 text-[13px] font-semibold">
                  <FlaskConical className="size-3.5 text-fg-3" aria-hidden /> Simulated
                </p>
                <ul className="mt-4 space-y-2.5 text-[13.5px] text-fg-2">
                  {SIMULATED.map((t) => (
                    <li key={t} className="flex gap-2.5">
                      <span aria-hidden className="mt-[8px] size-1 shrink-0 rounded-full bg-fg-4" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="mt-4 text-[12px] text-fg-3">Testnet USDC has no monetary value. Demo tokens are not valid on any physical meter.</p>
          </div>
        </section>

        {/* CTA */}
        <section>
          <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-6 px-4 py-16 sm:px-6">
            <div>
              <h2 className="text-[26px] font-semibold tracking-[-0.03em]">See it buy something.</h2>
              <p className="mt-1.5 text-[14px] text-fg-2">Load a scenario from the demo controls, start a run, and watch each step arrive.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/agent" className="inline-flex h-11 items-center gap-2 rounded-full bg-green px-5 text-[14px] font-medium text-white transition-colors hover:bg-green-hover">
                Start an agent run <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link href="/providers" className="inline-flex h-11 items-center gap-1.5 rounded-full bg-surface px-5 text-[14px] font-medium text-fg shadow-ring hover:bg-raised">
                Provider network <ArrowUpRight className="size-4" aria-hidden />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line-soft">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3 px-4 py-6 text-[12px] text-fg-3 sm:px-6">
          <span className="flex items-center gap-2">
            <BrandMark className="size-3.5 text-fg-3" /> Borderless · Stellar testnet demo
          </span>
          <span>Utilities, devices and providers are simulated. Payments are real testnet transactions.</span>
        </div>
      </footer>
    </div>
  );
}
