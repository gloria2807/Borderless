import type { Metadata } from "next";
import Link from "next/link";
import { KeyValue, PageHeader, Panel, SimulatedTag, StatusPill } from "@/components/ui/primitives";
import { dayTime, duration, maskMsisdn, meterId, naira, NETWORK_NAMES, quantity, shortAddress, UTILITY_NAMES } from "@/lib/format";
import { URGENCY } from "@/lib/status";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { getUtilityAccounts } from "@/server/views/accounts";

export const metadata: Metadata = { title: "Utility accounts" };
export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const accounts = await getUtilityAccounts(DEMO_HOUSEHOLD);
  return (
    <>
      <PageHeader
        eyebrow="Household"
        title="Utility accounts"
        description="The household's prepaid meter and phone line, the providers that can serve each one, and what Borderless has bought for it. Providers are paid only at their registered testnet wallet."
      />
      <div className="space-y-6">
        {accounts.map((a) => {
          const urgency = URGENCY[a.urgency] ?? { label: a.urgency, tone: "neutral" as const };
          return (
            <Panel
              key={a.id}
              title={`${UTILITY_NAMES[a.kind]} · ${a.label}`}
              description={a.kind === "electricity" ? `Meter ${meterId(a.identifier)}` : `${maskMsisdn(a.identifier)} · ${a.network ? NETWORK_NAMES[a.network] : ""}`}
              actions={<SimulatedTag>Simulated account</SimulatedTag>}
            >
              <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
                <div>
                  <dl className="divide-y divide-line-soft">
                    <KeyValue label="Balance" mono>{quantity(a.balance, a.unit)}</KeyValue>
                    <KeyValue label="Service left">
                      <span className="inline-flex items-center gap-2">
                        <span className="mono">{duration(a.hoursRemaining)}</span>
                        <StatusPill tone={urgency.tone} pulse={false}>{urgency.label}</StatusPill>
                      </span>
                    </KeyValue>
                    <KeyValue label="Forecast confidence">{a.confidence}</KeyValue>
                    <KeyValue label="Purchases completed" mono>{a.stats.completed}</KeyValue>
                    <KeyValue label="Spent" mono>{naira(a.stats.spentNgn)}</KeyValue>
                    {a.stats.failed > 0 && <KeyValue label="Failed (not charged)" mono>{a.stats.failed}</KeyValue>}
                    <KeyValue label="Last purchase">
                      {a.stats.lastPurchaseId ? (
                        <Link href={`/transactions/${a.stats.lastPurchaseId}`} className="hover:underline">
                          {dayTime(a.stats.lastAt!)}
                        </Link>
                      ) : (
                        "None yet"
                      )}
                    </KeyValue>
                  </dl>
                </div>
                <div className="min-w-0">
                  <h3 className="mb-2 text-[13px] font-semibold text-fg-2">Providers that can serve this account</h3>
                  <ul className="space-y-2">
                    {a.providers.map((p) => (
                      <li key={p.id} className="rounded-lg bg-bg px-3 py-2.5 shadow-[inset_0_0_0_1px_rgb(12_13_12/0.07)]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-semibold text-fg">{p.name}</span>
                          {p.isDefault && <span className="text-2xs text-fg-3">default for manual top-ups</span>}
                          <span className="ml-auto flex flex-wrap gap-1.5">
                            {!p.servesNetwork ? (
                              <StatusPill tone="neutral" pulse={false}>Doesn&apos;t serve this network</StatusPill>
                            ) : (
                              <>
                                <StatusPill tone={p.available ? "positive" : "critical"} pulse={false}>{p.available ? "Available" : "Unavailable"}</StatusPill>
                                <StatusPill tone={p.approved ? "info" : "warning"} pulse={false}>{p.approved ? "Approved" : "Not approved"}</StatusPill>
                              </>
                            )}
                          </span>
                        </div>
                        <p className="mt-1 text-[13px] text-fg-2">{p.offer}</p>
                        <p className="mt-1 text-2xs text-fg-3">
                          {p.products} options, {naira(p.priceFromNgn)}–{naira(p.priceToNgn)} · paid by x402 in test USDC to{" "}
                          <span className="mono text-fg-2" title={p.payTo ?? undefined}>{p.payTo ? shortAddress(p.payTo) : "not configured"}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-2xs text-fg-3">
                    Approve or block providers in <Link href="/settings" className="underline">Settings</Link>. Outages can be simulated from Demo controls.
                  </p>
                </div>
              </div>
            </Panel>
          );
        })}
      </div>
    </>
  );
}
