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
    "/": o.awaitingApproval.length,
    "/transactions": o.needsAttention.length,
  };
  const demo = {
    utilities: o.utilities.map((u) => ({ kind: u.kind, multiplier: u.usageMultiplier, providerAvailable: u.providerAvailable })),
    faults: o.faults,
    simNow: o.household.simNow,
    scenario: o.scenario,
  };

  return (
    <ToastProvider>
      <BusyProvider>
        <LiveRefresh />
        <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
          <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line-soft bg-bg-2 px-3 py-5 lg:flex">
            <Link href="/" className="mb-7 flex items-center gap-2.5 px-3 text-fg">
              <BrandMark className="size-5 text-green" />
              <span className="text-[15px] font-bold tracking-[-0.01em]">Borderless</span>
            </Link>
            <SideNav badges={badges} />

            <div className="mt-auto space-y-3 px-1">
              <div className="rounded-md border border-line-soft px-3 py-2.5">
                <p className="text-2xs text-fg-3">Household time (simulated)</p>
                <p className="mono mt-0.5 text-[13px] text-fg">{dayTime(o.household.simNow)}</p>
              </div>
              <DemoControls {...demo} />
              <p className="px-2 text-2xs leading-relaxed text-fg-3">
                Payments are real transactions on Stellar <span className="text-cyan">testnet</span> using testnet USDC, which has no monetary value. Electricity, airtime and data are simulated.
              </p>
            </div>
          </aside>

          <div className="min-w-0">
            <header className="sticky top-0 z-30 border-b border-line-soft bg-bg/95 px-4 pt-3 backdrop-blur lg:hidden">
              <div className="mb-2 flex items-center justify-between gap-3">
                <Link href="/" className="flex items-center gap-2 text-fg">
                  <BrandMark className="size-5 text-green" />
                  <span className="font-bold">Borderless</span>
                </Link>
                <div className="flex items-center gap-2">
                  <span className="mono text-2xs text-fg-3">{dayTime(o.household.simNow)}</span>
                  <DemoControls {...demo} compact />
                </div>
              </div>
              <TopNav badges={badges} />
            </header>
            <main className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
            <footer className="px-4 pb-8 text-2xs text-fg-3 sm:px-6 lg:hidden">
              Payments use Stellar testnet USDC (no monetary value). Utilities are simulated.
            </footer>
          </div>
        </div>
      </BusyProvider>
    </ToastProvider>
  );
}
