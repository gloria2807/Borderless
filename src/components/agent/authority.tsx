import Link from "next/link";
import { naira, NETWORK_NAMES, shortAddress, UTILITY_NAMES } from "@/lib/format";
import { KeyValue, Panel, StatusPill, TestnetTag } from "@/components/ui/primitives";
import type { HouseholdOverview } from "@/server/views/household";

/** What Borderless is allowed to do right now — always inspectable by the owner. */
export function AuthorityPanel({ o }: { o: HouseholdOverview }) {
  const p = o.policy;
  return (
    <Panel
      title="Spending authority"
      description="Enforced on the server before any payment is signed"
      actions={
        <Link href="/settings" className="text-[13px] font-medium text-fg-2 hover:text-fg">
          Change
        </Link>
      }
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] text-fg-2">Automatic purchasing</span>
        {p.autoPurchaseEnabled ? <StatusPill tone="positive" pulse={false}>On</StatusPill> : <StatusPill tone="critical" pulse={false}>Off, recommendations only</StatusPill>}
      </div>
      <dl className="divide-y divide-line-soft">
        <KeyValue label="Per purchase, up to" mono>{naira(p.perPurchaseLimitNgn)}</KeyValue>
        <KeyValue label="Asks you first above" mono>{naira(p.manualApprovalThresholdNgn)}</KeyValue>
        <KeyValue label="Total agent limit this period" mono>{naira(p.overallAgentLimitNgn)}</KeyValue>
        {p.dailyAgentBudgetNgn !== undefined && <KeyValue label="Per day, up to" mono>{naira(p.dailyAgentBudgetNgn)}</KeyValue>}
        {p.taskBudgetNgn !== undefined && <KeyValue label="Per run, up to" mono>{naira(p.taskBudgetNgn)}</KeyValue>}
        {!!p.reserveNgn && <KeyValue label="Kept in reserve" mono>{naira(p.reserveNgn)}</KeyValue>}
        {Object.entries(p.maxPerUtilityNgn ?? {}).map(([k, n]) => (
          <KeyValue key={k} label={`${UTILITY_NAMES[k as keyof typeof UTILITY_NAMES]} cap`} mono>{naira(n ?? 0)}</KeyValue>
        ))}
        <KeyValue label="Left to spend" mono>{naira(Math.min(o.budget.summary.agentAuthorityRemainingNgn, o.budget.summary.remainingNgn))}</KeyValue>
        <KeyValue label="Priorities">{o.priorities.map((k) => UTILITY_NAMES[k]).join(", then ")}</KeyValue>
        <KeyValue label="Approved services">{p.approvedServices.map((k) => UTILITY_NAMES[k]).join(", ") || "None"}</KeyValue>
        <KeyValue label="Approved networks">{p.approvedNetworks.map((n) => NETWORK_NAMES[n]).join(", ") || "None"}</KeyValue>
      </dl>
      <div className="mt-4 rounded-md border border-line-soft bg-bg-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-fg-2">Payment wallet</span>
          <TestnetTag />
        </div>
        <dl className="mt-2 space-y-1 text-2xs">
          <div className="flex justify-between gap-3">
            <dt className="text-fg-3">Address</dt>
            <dd className="mono text-cyan" title={o.wallet.agentAddress ?? undefined}>{o.wallet.agentAddress ? shortAddress(o.wallet.agentAddress) : "Not configured"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-fg-3">Pays with</dt>
            <dd className="text-fg-2">{o.wallet.asset}, via x402</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-fg-3">Demo pricing</dt>
            <dd className="mono text-fg-2">{naira(o.wallet.ngnPerUsdc)} = 1 USDC</dd>
          </div>
        </dl>
        <p className="mt-2 text-2xs text-fg-3">Demo pricing is a fixed setting, not an exchange rate. The signing key stays on the server and is never sent to the browser.</p>
      </div>
    </Panel>
  );
}
