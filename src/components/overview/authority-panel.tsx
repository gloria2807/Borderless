import Link from "next/link";
import { cn, Panel } from "@/components/ui/primitives";
import { naira } from "@/lib/format";
import type { SpendingAuthorityView } from "@/server/views/authority";

const usdc = (ngn: number, rate: number) => (ngn / rate).toFixed(2);

/** Each limit on its own line, so budget, daily, task, request and wallet are never confused. */
export function AuthorityPanel({ a }: { a: SpendingAuthorityView }) {
  const r = a.ngnPerUsdc;
  return (
    <Panel
      title="Spending authority"
      description="What the owner has delegated, and what's left of it"
      actions={
        <Link href="/settings" className="text-[12.5px] font-medium text-fg-2 hover:text-fg">
          Change
        </Link>
      }
    >
      <div className="rounded-lg bg-green-soft/70 px-3.5 py-3">
        <p className="text-[11.5px] text-fg-2">Borderless can spend now, without asking</p>
        <p className="mt-0.5 text-[26px] leading-8 font-semibold tracking-[-0.035em] tabular">
          {a.paused ? "0.00" : usdc(a.spendableAutoNgn, r)} <span className="text-[13px] font-normal tracking-normal text-fg-3">USDC</span>
        </p>
        <p className="mt-0.5 text-[11.5px] text-fg-2">
          {a.paused
            ? "Paused by you: nothing can be spent."
            : !a.autoPurchaseEnabled
              ? "Automatic purchasing is off: Borderless only recommends."
              : `Per purchase. Up to ${usdc(a.spendableMaxNgn, r)} USDC with your approval, limited by ${a.bindingConstraint}.`}
        </p>
      </div>
      <dl className="mt-3 divide-y divide-line-soft">
        {a.rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2">
            <dt className="min-w-0">
              <span className="block text-[12.5px] text-fg">{row.label}</span>
              <span className="block text-[11px] text-fg-3">{row.note}</span>
            </dt>
            <dd className="text-right">
              <span className={cn("block text-[13px] font-medium tabular", row.key === "wallet" && row.remainingNgn === null && "text-amber")}>
                {row.remainingNgn !== null ? `${usdc(row.remainingNgn, r)} USDC` : row.limitNgn !== null ? `${usdc(row.limitNgn, r)} USDC` : "Unavailable"}
              </span>
              <span className="mono block text-[10.5px] text-fg-3">
                {row.remainingNgn !== null && row.limitNgn !== null ? `left of ${usdc(row.limitNgn, r)}` : row.remainingNgn !== null ? naira(row.remainingNgn) : row.limitNgn !== null ? "limit" : ""}
              </span>
            </dd>
          </div>
        ))}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2">
          <dt>
            <span className="block text-[12.5px] text-fg">Pending commitments</span>
            <span className="block text-[11px] text-fg-3">Requested or awaiting approval, not yet paid.</span>
          </dt>
          <dd className="text-right text-[13px] font-medium tabular">{usdc(a.pendingNgn, r)} USDC</dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-fg-3">
        Fixed demo rate: 1 test USDC = {naira(r)} of household value. Testnet USDC has no monetary value.
      </p>
    </Panel>
  );
}
