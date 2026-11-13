"use client";

import { useId, useState } from "react";
import { ExternalLink, Landmark, ShieldOff } from "lucide-react";
import { Button, cn, KeyValue, StatusPill, TestnetTag } from "@/components/ui/primitives";
import { ConfirmButton, useApiAction } from "@/components/ui/interactive";
import { atomicToDecimal, shortAddress, shortHash } from "@/lib/format";
import type { FundingGuardStatus } from "@/server/payments/funding-guard";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Lagos" });

/**
 * Funding guard: a Stellar-enforced ceiling on what the agent wallet can draw from the
 * household treasury. Shows the live on-chain allowance and lets the owner grant or revoke.
 */
export function FundingGuardPanel({ status, explorer }: { status: FundingGuardStatus; explorer: string }) {
  const { run, pending } = useApiAction();
  const [amount, setAmount] = useState("1");
  const [days, setDays] = useState("7");
  const amountId = useId();
  const daysId = useId();

  if (!status.configured) {
    return (
      <p className="text-[13px] text-fg-3">
        Not set up. Run <code className="mono text-fg-2">pnpm wallets:setup</code> to create the household treasury wallet, then restart the app.
      </p>
    );
  }

  const left = status.allowanceAtomic ? BigInt(status.allowanceAtomic) : 0n;
  const active = left > 0n && !status.grant?.revokedAt;
  const g = status.grant;
  const link = (hash: string) => (
    <a href={`${explorer}/${hash}`} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1 text-cyan hover:underline">
      {shortHash(hash, 6)} <ExternalLink className="size-3" aria-hidden />
      <span className="sr-only">(opens Stellar Expert)</span>
    </a>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {status.error ? (
          <StatusPill tone="warning" pulse={false}>Couldn&apos;t read the network</StatusPill>
        ) : active ? (
          <StatusPill tone="positive" pulse={false}>Active</StatusPill>
        ) : (
          <StatusPill tone="neutral" pulse={false}>{g?.revokedAt ? "Revoked" : g ? "Used up or expired" : "No allowance"}</StatusPill>
        )}
        <TestnetTag />
      </div>
      {status.error && <p className="text-2xs text-amber">{status.error}</p>}

      <dl className="divide-y divide-line-soft rounded-md border border-line-soft bg-bg-2 px-3">
        <KeyValue label="Treasury" mono>
          <span title={status.treasury ?? undefined}>{status.treasury ? shortAddress(status.treasury) : "—"}</span>
        </KeyValue>
        <KeyValue label="Treasury holds" mono>{status.treasuryBalanceAtomic ? `${atomicToDecimal(status.treasuryBalanceAtomic)} test USDC` : "—"}</KeyValue>
        <KeyValue label="Agent wallet may still draw" mono>{status.allowanceAtomic !== null ? `${atomicToDecimal(status.allowanceAtomic)} test USDC` : "—"}</KeyValue>
        {g && <KeyValue label="Granted cap" mono>{`${atomicToDecimal(g.capAtomic)} test USDC`}</KeyValue>}
        {g && !g.revokedAt && (
          <KeyValue label="Expires" mono>
            {status.expiresAtEstimate ? `~${when(status.expiresAtEstimate)} (ledger ${g.expirationLedger})` : `ledger ${g.expirationLedger} (passed)`}
          </KeyValue>
        )}
        {g && <KeyValue label="Grant transaction">{link(g.grantTxHash)}</KeyValue>}
        {g?.revokeTxHash && <KeyValue label="Revoke transaction">{link(g.revokeTxHash)}</KeyValue>}
      </dl>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run("/api/funding-guard", { body: { action: "grant", amountUsdc: Number(amount), days: Number(days) } }, { success: () => ({ title: "Allowance granted on Stellar", body: "The agent wallet can top up within this cap." }), errorTitle: "Couldn't grant the allowance" });
        }}
      >
        <div>
          <label htmlFor={amountId} className="text-[13px] font-medium text-fg-2">
            Cap (test USDC)
          </label>
          <input id={amountId} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} className="mono mt-1.5 block h-9 w-28 rounded-md border border-line bg-bg-2 px-3 text-[13px] text-fg outline-none focus:border-green" />
        </div>
        <div>
          <label htmlFor={daysId} className="text-[13px] font-medium text-fg-2">
            For (days)
          </label>
          <input id={daysId} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ""))} className="mono mt-1.5 block h-9 w-20 rounded-md border border-line bg-bg-2 px-3 text-[13px] text-fg outline-none focus:border-green" />
        </div>
        <Button type="submit" variant="secondary" loading={pending} disabled={!(Number(amount) >= 0.01 && Number(amount) <= 10 && Number(days) >= 1 && Number(days) <= 30)}>
          {!pending && <Landmark className="size-4" aria-hidden />}
          {g && !g.revokedAt ? "Replace allowance" : "Grant allowance"}
        </Button>
        {active && (
          <ConfirmButton
            variant="danger"
            disabled={pending}
            title="Revoke the Funding guard allowance?"
            body="The treasury will sign approve(0) on Stellar. The agent wallet keeps what it already holds but can no longer draw more."
            confirmLabel="Revoke now"
            onConfirm={async () => void (await run("/api/funding-guard", { body: { action: "revoke" } }, { success: () => ({ title: "Allowance revoked on Stellar", body: "The agent wallet can no longer draw from the treasury." }), errorTitle: "Couldn't revoke" }))}
          >
            <ShieldOff className="size-4" aria-hidden /> Revoke
          </ConfirmButton>
        )}
      </form>
      <p className={cn("text-2xs text-fg-3")}>
        Stellar enforces the cap and expiry: if the agent key leaked, the most it could move is its own balance plus what is left here. It does not limit where the agent pays or the size of each payment — your spending rules above do that.
      </p>
    </div>
  );
}
