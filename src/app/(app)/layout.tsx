import Link from "next/link";
import { BrandMark, SideNav, TopNav } from "@/components/shell/nav";
import { DemoControls } from "@/components/demo/demo-controls";
import { BusyProvider, LiveRefresh, ToastProvider } from "@/components/ui/interactive";
import { dayTime } from "@/lib/format";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { getHouseholdOverview } from "@/server/views/household";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const o = await getHouseholdOverview(DEMO_HOUSEHOLD);
  const badges = {
    "/overview": o.awaitingApproval.length,
    "/transactions": o.needsAttention.length,
  };
  const demo = {
    utilities: o.utilities.map((u) => ({ kind: u.kind, multiplier: u.usageMultiplier, providerAvailable: u.providerAvailable })),
    providers: o.providers,
    faults: o.faults,
    simNow: o.household.simNow,
    scenario: o.scenario,
    agent: { paused: !!o.policy.agentPaused, autoPurchaseEnabled: o.policy.autoPurchaseEnabled },
  };

  return (
    <ToastProvider>
      <BusyProvider>
        <LiveRefresh />
        <div className="min-h-dvh lg:grid lg:grid-cols-[224px_minmax(0,1fr)]">
          <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line-soft px-3 pt-5 pb-4 lg:flex">
            <Link href="/" className="mb-6 flex items-center gap-2 px-2 text-fg" aria-label="Borderless home">
              <BrandMark className="size-[18px] text-green" />
              <span className="text-[15px] font-semibold tracking-[-0.02em]">Borderless</span>
            </Link>

            <div className="mb-5 rounded-lg bg-surface px-3 py-2.5 shadow-ring">
              <p className="truncate text-[12.5px] font-medium text-fg">{o.household.name}</p>
              {o.household.owner && <p className="truncate text-[11px] text-fg-2">{o.household.owner}, owner</p>}
              <p className="mt-1 text-[11px] text-fg-3">Household time</p>
              <p className="mono text-[11.5px] text-fg-2">{dayTime(o.household.simNow)}</p>
            </div>

            <SideNav badges={badges} />

            <div className="mt-auto space-y-3">
              <DemoControls {...demo} />
              <p className="px-2 text-[11px] leading-relaxed text-fg-3">
                Payments are real transactions on Stellar <span className="font-medium text-cyan">testnet</span> in testnet USDC, which has no monetary value. Electricity, airtime and data are simulated.
              </p>
            </div>
          </aside>

          <div className="min-w-0">
            <header className="sticky top-0 z-30 border-b border-line-soft bg-bg/90 px-4 pt-3 backdrop-blur-md lg:hidden">
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <Link href="/" className="flex items-center gap-2 text-fg" aria-label="Borderless home">
                  <BrandMark className="size-[18px] text-green" />
                  <span className="font-semibold tracking-[-0.02em]">Borderless</span>
                </Link>
                <div className="flex items-center gap-2">
                  <span className="mono hidden text-2xs text-fg-3 min-[400px]:inline">{dayTime(o.household.simNow)}</span>
                  <DemoControls {...demo} compact />
                </div>
              </div>
              <TopNav badges={badges} />
            </header>
            <main className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">{children}</main>
            <footer className="px-4 pb-8 text-2xs text-fg-3 sm:px-6 lg:hidden">
              Payments use Stellar testnet USDC (no monetary value). Utilities are simulated.
            </footer>
          </div>
        </div>
      </BusyProvider>
    </ToastProvider>
  );
}
