import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, ReceiptText } from "lucide-react";
import { EmptyState, PageHeader, Panel, StatusPill, TestnetTag } from "@/components/ui/primitives";
import { atomicToDecimal, dayTime, maskMsisdn, meterId, naira, shortHash, UTILITY_NAMES } from "@/lib/format";
import { FULFILMENT_STATUS, PAYMENT_STATUS, STAGE } from "@/lib/status";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { getPurchases, type PurchaseRowView } from "@/server/views/household";

export const metadata: Metadata = { title: "Transactions" };
export const dynamic = "force-dynamic";

const recipientOf = (p: PurchaseRowView) => (p.kind === "electricity" ? meterId(p.recipient) : maskMsisdn(p.recipient));

function Statuses({ p }: { p: PurchaseRowView }) {
  if (p.stage === "awaiting_approval" || p.stage === "cancelled") return <StatusPill tone={STAGE[p.stage]!.tone}>{STAGE[p.stage]!.label}</StatusPill>;
  const pay = PAYMENT_STATUS[p.paymentStatus]!;
  const ful = FULFILMENT_STATUS[p.fulfilmentStatus]!;
  return (
    <div className="flex flex-wrap gap-1.5">
      <StatusPill tone={pay.tone} title={pay.hint}>{pay.label}</StatusPill>
      <StatusPill tone={ful.tone} title={ful.hint}>{ful.label}</StatusPill>
    </div>
  );
}

export default async function TransactionsPage() {
  const rows = await getPurchases(DEMO_HOUSEHOLD);
  const paid = rows.filter((r) => r.paymentStatus === "confirmed");
  const totalNgn = paid.reduce((t, r) => t + r.amountNgn, 0);
  const totalUsdc = paid.reduce((t, r) => t + BigInt(r.amountAtomic ?? "0"), 0n);

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every purchase, with its Stellar testnet payment and its simulated fulfilment recorded separately."
        actions={<TestnetTag />}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-line bg-surface px-4 py-3">
          <p className="text-2xs text-fg-3">Purchases</p>
          <p className="mono mt-1 text-xl">{rows.length}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface px-4 py-3">
          <p className="text-2xs text-fg-3">Confirmed spend (household value)</p>
          <p className="mono mt-1 text-xl">{naira(totalNgn)}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface px-4 py-3">
          <p className="text-2xs text-fg-3">Settled on testnet</p>
          <p className="mono mt-1 text-xl">
            {atomicToDecimal(totalUsdc)} <span className="text-sm text-fg-3">USDC</span>
          </p>
        </div>
      </div>

      <Panel bodyClassName="p-0">
        {rows.length === 0 ? (
          <EmptyState icon={<ReceiptText className="size-6" />} title="No transactions yet">
            Purchases appear here once Borderless (or you) buys electricity, airtime or data.
          </EmptyState>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-[13px]">
                <caption className="sr-only">Purchases, newest first</caption>
                <thead className="border-b border-line-soft text-2xs text-fg-3">
                  <tr>
                    <th scope="col" className="px-5 py-2.5 font-medium">Purchase</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Recipient</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Amount</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Testnet payment</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Payment and fulfilment</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Transaction</th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium">Household time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {rows.map((p) => (
                    <tr key={p.id} className="group relative hover:bg-raised/50">
                      <td className="px-5 py-3">
                        <Link href={`/transactions/${p.id}`} className="font-semibold text-fg after:absolute after:inset-0 group-hover:underline">
                          {p.label}
                        </Link>
                        <p className="mono text-2xs text-fg-3">
                          {UTILITY_NAMES[p.kind]}, {p.id}
                        </p>
                      </td>
                      <td className="mono px-3 py-3 whitespace-nowrap text-fg-2">{recipientOf(p)}</td>
                      <td className="mono px-3 py-3 text-right">{naira(p.amountNgn)}</td>
                      <td className="mono px-3 py-3 text-right whitespace-nowrap text-fg-2">{p.amountAtomic ? `${atomicToDecimal(p.amountAtomic)} ${p.asset}` : "None"}</td>
                      <td className="px-3 py-3">
                        <Statuses p={p} />
                      </td>
                      <td className="px-3 py-3">
                        {p.txHash ? (
                          <a href={p.explorerUrl!} target="_blank" rel="noreferrer" className="relative z-10 inline-flex items-center gap-1 mono whitespace-nowrap text-2xs text-cyan hover:underline" title={p.txHash}>
                            {shortHash(p.txHash, 6)} <ArrowUpRight className="size-3" aria-hidden />
                          </a>
                        ) : (
                          <span className="text-2xs text-fg-3">None</span>
                        )}
                      </td>
                      <td className="mono px-5 py-3 text-right whitespace-nowrap text-2xs text-fg-3">{dayTime(p.simTime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile list */}
            <ul className="divide-y divide-line-soft md:hidden">
              {rows.map((p) => (
                <li key={p.id}>
                  <Link href={`/transactions/${p.id}`} className="block px-4 py-3.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-semibold">{p.label}</span>
                      <span className="mono text-[13px]">{naira(p.amountNgn)}</span>
                    </div>
                    <p className="mono mt-0.5 text-2xs text-fg-3">
                      {recipientOf(p)}, {dayTime(p.simTime)}
                    </p>
                    <div className="mt-2">
                      <Statuses p={p} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </>
  );
}
