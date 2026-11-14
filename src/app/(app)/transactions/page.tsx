import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, ReceiptText } from "lucide-react";
import { EmptyState, KpiStrip, PageHeader, Panel, StatusPill, TestnetTag } from "@/components/ui/primitives";
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

const STATUS_FILTERS: Record<string, { label: string; match: (p: PurchaseRowView) => boolean }> = {
  completed: { label: "Completed", match: (p) => p.stage === "completed" },
  in_progress: { label: "In progress", match: (p) => ["requested", "payment_required", "submitted"].includes(p.stage) },
  awaiting_approval: { label: "Awaiting approval", match: (p) => p.stage === "awaiting_approval" },
  needs_attention: { label: "Needs attention", match: (p) => p.stage === "needs_attention" },
  failed: { label: "Failed (not charged)", match: (p) => p.stage === "failed" },
  cancelled: { label: "Declined or expired", match: (p) => p.stage === "cancelled" },
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";

/** Free-text match over what an owner would search by: product, provider, recipient, ids, hash, failure. */
function matches(p: PurchaseRowView, q: string): boolean {
  if (!q) return true;
  const hay = [p.id, p.label, p.providerName, p.recipient, p.kind, UTILITY_NAMES[p.kind], p.txHash, p.failureCode, p.failureMessage, String(p.amountNgn), naira(p.amountNgn)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((term) => hay.includes(term.replace(/^₦/, "")) || hay.includes(term));
}

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = one(sp.q).slice(0, 100);
  const utility = one(sp.utility);
  const status = one(sp.status);
  const all = await getPurchases(DEMO_HOUSEHOLD);
  const filtering = Boolean(q || (utility && utility in UTILITY_NAMES) || (status && status in STATUS_FILTERS));
  const rows = all.filter((p) => matches(p, q) && (!(utility in UTILITY_NAMES) || p.kind === utility) && (!(status in STATUS_FILTERS) || STATUS_FILTERS[status]!.match(p)));
  const paid = all.filter((r) => r.paymentStatus === "confirmed");
  const totalNgn = paid.reduce((t, r) => t + r.amountNgn, 0);
  const totalUsdc = paid.reduce((t, r) => t + BigInt(r.amountAtomic ?? "0"), 0n);

  return (
    <>
      <PageHeader
        eyebrow="Ledger"
        title="Transactions"
        description="Every purchase, with its Stellar testnet payment and its simulated fulfilment recorded separately."
        actions={<TestnetTag />}
      />

      <KpiStrip
        className="mb-6"
        items={[
          { label: "Purchases", value: String(all.length), hint: `${paid.length} paid and confirmed` },
          { label: "Confirmed spend", value: naira(totalNgn), hint: "Household value" },
          { label: "Settled on testnet", value: <>{atomicToDecimal(totalUsdc)} <span className="text-[13px] font-normal tracking-normal text-fg-3">USDC</span></>, hint: "Testnet USDC, no monetary value" },
        ]}
      />

      <form role="search" aria-label="Search transactions" method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label htmlFor="tx-q" className="label">
            Search
          </label>
          <input
            id="tx-q"
            name="q"
            type="search"
            defaultValue={q}
            maxLength={100}
            placeholder="Provider, product, phone or meter, transaction hash…"
            className="mt-1.5 h-9 w-full rounded-lg border border-line bg-raised px-3 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-green focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-green)_15%,transparent)]"
          />
        </div>
        <div>
          <label htmlFor="tx-utility" className="label">
            Utility
          </label>
          <select id="tx-utility" name="utility" defaultValue={utility} className="mt-1.5 block h-9 rounded-lg border border-line bg-raised px-2 text-[13px] text-fg outline-none focus:border-green focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-green)_15%,transparent)]">
            <option value="">All</option>
            {(["electricity", "airtime", "data"] as const).map((k) => (
              <option key={k} value={k}>
                {UTILITY_NAMES[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tx-status" className="label">
            Status
          </label>
          <select id="tx-status" name="status" defaultValue={status} className="mt-1.5 block h-9 rounded-lg border border-line bg-raised px-2 text-[13px] text-fg outline-none focus:border-green focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-green)_15%,transparent)]">
            <option value="">All</option>
            {Object.entries(STATUS_FILTERS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="h-9 rounded-full bg-ink px-4 text-[13px] font-medium text-white transition-colors hover:bg-ink-2 focus-visible:outline-2 focus-visible:outline-green">
          Search
        </button>
        {filtering && (
          <Link href="/transactions" className="h-9 px-2 text-[13px] leading-9 text-fg-3 hover:text-fg">
            Clear
          </Link>
        )}
      </form>
      {filtering && (
        <p className="mb-3 text-[13px] text-fg-3" aria-live="polite">
          {rows.length} of {all.length} purchase{all.length === 1 ? "" : "s"} match.
        </p>
      )}

      <Panel bodyClassName="p-0">
        {rows.length === 0 && filtering ? (
          <EmptyState icon={<ReceiptText className="size-6" />} title="No purchases match" action={<Link href="/transactions" className="text-[13px] font-medium text-fg-2 underline">Clear the search</Link>}>
            Try a provider name, a product, a phone number or meter, or part of a Stellar transaction hash.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState icon={<ReceiptText className="size-6" />} title="No transactions yet">
            Purchases appear here once Borderless (or you) buys electricity, airtime or data.
          </EmptyState>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-[13px]">
                <caption className="sr-only">Purchases, newest first</caption>
                <thead className="mono border-b border-line-soft bg-bg/60 text-[10px] tracking-[0.08em] text-fg-3 uppercase">
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
                    <tr key={p.id} className="group relative transition-colors hover:bg-fg/[0.025]">
                      <td className="px-5 py-3">
                        <Link href={`/transactions/${p.id}`} className="font-medium text-fg after:absolute after:inset-0 group-hover:underline">
                          {p.label}
                        </Link>
                        <p className="mono mt-0.5 text-[10.5px] text-fg-3">
                          {p.providerName} · {UTILITY_NAMES[p.kind]} · {p.id}
                        </p>
                      </td>
                      <td className="mono px-3 py-3 whitespace-nowrap text-fg-2">{recipientOf(p)}</td>
                      <td className="px-3 py-3 text-right font-medium tabular">{naira(p.amountNgn)}</td>
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
