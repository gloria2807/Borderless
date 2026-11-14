"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BatteryLow, RotateCcw, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/primitives";
import { ConfirmButton, useApiAction, useToast } from "@/components/ui/interactive";

/**
 * Primary live-demo controls. Each one is a real backend operation:
 *  - Simulate low balance lowers the persisted meter and starts a genuine agent run;
 *  - Reset reloads the primary scenario (testnet transactions already made are untouched);
 *  - Attempt over-limit purchase instructs the agent to overspend, for the wallet to refuse.
 */
export function SimulateLowBalanceButton({ size = "md", disabled, mode = "deterministic" }: { size?: "sm" | "md"; disabled?: boolean; mode?: "ai" | "deterministic" }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="primary"
      size={size}
      loading={pending}
      disabled={disabled}
      onClick={async () => {
        setPending(true);
        try {
          const res = await fetch("/api/demo/low-balance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "electricity", mode }) });
          const d = (await res.json().catch(() => ({}))) as { runId?: string | null; balanceAfter?: number; runNotStarted?: { code: string; message: string; runId?: string } | null; message?: string };
          if (!res.ok) {
            toast({ tone: "critical", title: "Couldn't simulate a low balance", body: d.message ?? `HTTP ${res.status}` });
            return;
          }
          if (d.runId) {
            toast({ tone: "info", title: `Meter lowered to ${d.balanceAfter} kWh`, body: "Borderless is assessing the household. Watch each step live." });
            router.push(`/agent/runs/${d.runId}`);
          } else {
            toast({ tone: "info", title: `Meter lowered to ${d.balanceAfter} kWh`, body: d.runNotStarted?.message ?? "Borderless did not start a run." });
            if (d.runNotStarted?.runId) router.push(`/agent/runs/${d.runNotStarted.runId}`);
            else router.refresh();
          }
        } catch (err) {
          toast({ tone: "critical", title: "Network error", body: (err as Error).message });
        } finally {
          setPending(false);
        }
      }}
    >
      {!pending && <BatteryLow className="size-4" aria-hidden />}
      Simulate low balance
    </Button>
  );
}

export function ResetDemoButton({ scenario = "primary-electricity", label = "Reset demo" }: { scenario?: string; label?: string }) {
  const { run, pending } = useApiAction();
  return (
    <ConfirmButton
      size="sm"
      variant="ghost"
      loading={pending}
      title="Reset the demo household?"
      body="Reloads the primary electricity scenario: balances, budget, decisions and purchase history in this app. Testnet transactions already on Stellar are permanent and are not affected."
      confirmLabel="Reset"
      onConfirm={async () => {
        await run<{ scenario: { name: string } }>("/api/demo/reset", { body: { scenario } }, { success: (d) => ({ title: `Reset: ${d.scenario.name}`, body: "Press Simulate low balance to start the demo." }) });
      }}
    >
      <RotateCcw className="size-3.5" aria-hidden /> {label}
    </ConfirmButton>
  );
}

export function OverLimitButton() {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={async () => {
        setPending(true);
        try {
          const res = await fetch("/api/demo/over-limit", { method: "POST" });
          const d = (await res.json().catch(() => ({}))) as { runId?: string; message?: string };
          if (res.ok && d.runId) router.push(`/agent/runs/${d.runId}`);
          else if (d.runId) router.push(`/agent/runs/${d.runId}`);
          else toast({ tone: "critical", title: "Couldn't start the attempt", body: d.message ?? `HTTP ${res.status}` });
        } finally {
          setPending(false);
        }
      }}
    >
      {!pending && <ShieldX className="size-3.5" aria-hidden />}
      Attempt over-limit purchase
    </Button>
  );
}
