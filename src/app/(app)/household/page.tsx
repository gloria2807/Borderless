import type { Metadata } from "next";
import Link from "next/link";
import { ManualBuy } from "@/components/devices/manual-buy";
import { VirtualMeter } from "@/components/devices/meter";
import { VirtualPhone } from "@/components/devices/phone";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { dayTime, naira, quantity, UTILITY_NAMES } from "@/lib/format";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { DEFAULT_PROVIDER } from "@/server/providers/registry";
import { getHouseholdOverview } from "@/server/views/household";

export const metadata: Metadata = { title: "Household" };
export const dynamic = "force-dynamic";

export default async function HouseholdPage() {
  const o = await getHouseholdOverview(DEMO_HOUSEHOLD);

  return (
    <>
      <PageHeader
        title="Household"
        description="Virtual devices that stand in for a prepaid meter and the household's phone line. Balances change only when simulated usage drains them or a provider releases a paid purchase."
      />
      {/* Subgrid keeps each row (device, top-up, history) aligned across the three columns. */}
      <div className="grid gap-x-6 gap-y-10 lg:grid-cols-3 lg:grid-rows-[auto_1fr_auto_auto] lg:gap-y-4">
        {o.utilities.map((u) => {
          const options = DEFAULT_PROVIDER[u.kind].listProducts().map((p) => ({
            value: u.kind === "data" ? p.code : String(p.amountNgn),
            label: u.kind === "data" ? p.label : naira(p.amountNgn),
            amountNgn: p.amountNgn,
          }));
          const inFlight = o.inFlight.find((p) => p.kind === u.kind) ?? o.awaitingApproval.find((p) => p.kind === u.kind) ?? o.needsAttention.find((p) => p.kind === u.kind);
          return (
            <section key={u.kind} id={u.kind} aria-labelledby={`${u.kind}-title`} className="grid scroll-mt-24 gap-4 lg:row-span-4 lg:grid-rows-subgrid">
              <h2 id={`${u.kind}-title`} className="text-sm font-semibold text-fg-2">
                {UTILITY_NAMES[u.kind]}
              </h2>
              {/* On desktop the device fills its subgrid row so the panels below line up. */}
              <div className="lg:[&>div]:h-full">
                {u.kind === "electricity" ? <VirtualMeter u={u} simNow={o.household.simNow} /> : <VirtualPhone u={u} simNow={o.household.simNow} />}
              </div>

              <Panel bodyClassName="p-4">
                <ManualBuy
                  kind={u.kind}
                  options={options}
                  disabledReason={inFlight ? "A purchase for this utility is already in progress." : !u.providerAvailable ? "The provider is unavailable (demo outage)." : null}
                />
                <p className="mt-2 text-2xs text-fg-3">Uses the household budget and the same testnet payment flow as Borderless.</p>
              </Panel>

              <Panel title="Recent purchases" bodyClassName="p-0">
                {u.history.length ? (
                  <ul className="divide-y divide-line-soft">
                    {u.history.map((h) => (
                      <li key={h.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13px]">
                        <div className="min-w-0">
                          <Link href={`/transactions/${h.id}`} className="font-medium text-fg hover:underline">
                            {h.label}
                          </Link>
                          <p className="text-2xs text-fg-3">{dayTime(h.at)}</p>
                        </div>
                        <div className="text-right">
                          <p className="mono text-green">+{quantity(h.quantity, u.unit)}</p>
                          <p className="mono text-2xs text-fg-3">{naira(h.amountNgn)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 py-4 text-[13px] text-fg-3">Nothing bought yet.</p>
                )}
              </Panel>
            </section>
          );
        })}
      </div>
    </>
  );
}
