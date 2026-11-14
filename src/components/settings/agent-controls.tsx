"use client";

import { OctagonX, Pause, Play } from "lucide-react";
import { Button, cn, Dot } from "@/components/ui/primitives";
import { ConfirmButton, useApiAction } from "@/components/ui/interactive";

/**
 * The owner's immediate controls. They act at once (no Save): pause stops Borderless at its next
 * step, emergency stop also revokes purchasing and declines pending approvals.
 */
export function AgentControls({ paused, autoPurchaseEnabled, compact = false }: { paused: boolean; autoPurchaseEnabled: boolean; compact?: boolean }) {
  const { run, pending } = useApiAction();
  const control = (action: "pause" | "resume" | "emergency_stop") =>
    run<{ paused: boolean; declinedApprovals: string[] }>("/api/agent/control", { body: { action } }, {
      success: (d) =>
        action === "pause"
          ? { title: "Borderless paused", body: "It won't assess, request or pay anything until you resume it." }
          : action === "resume"
            ? { title: "Borderless resumed", body: autoPurchaseEnabled ? "It can work again within your spending rules." : "It can monitor again. Automatic purchasing is still off." }
            : { title: "Emergency stop", body: `Paused, purchasing revoked${d.declinedApprovals.length ? `, ${d.declinedApprovals.length} pending approval declined` : ""}. Nothing further can be paid.` },
      errorTitle: "Couldn't change the agent's state",
    });

  const status = paused ? { tone: "critical" as const, text: "Paused by you" } : autoPurchaseEnabled ? { tone: "positive" as const, text: "Active" } : { tone: "warning" as const, text: "Monitoring only" };

  return (
    <div className={cn("flex flex-wrap items-center gap-3", compact ? "" : "justify-between rounded-lg bg-surface p-4 shadow-ring")}>
      {!compact && (
        <div>
          <p className="flex items-center gap-2 text-[13.5px] font-semibold">
            <Dot tone={status.tone} pulse={!paused && autoPurchaseEnabled} /> Borderless is {status.text.toLowerCase()}
          </p>
          <p className="mt-0.5 text-[12.5px] text-fg-2">
            {paused
              ? "No assessments, runs or payments. A task that was running stopped at its next step."
              : autoPurchaseEnabled
                ? "Monitoring the household and buying within the limits below."
                : "Monitoring and recommending, but not spending (automatic purchasing is off)."}
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {paused ? (
          <Button size="sm" variant="primary" loading={pending} onClick={() => control("resume")}>
            <Play className="size-3.5" aria-hidden /> Resume Borderless
          </Button>
        ) : (
          <Button size="sm" variant="secondary" loading={pending} onClick={() => control("pause")}>
            <Pause className="size-3.5" aria-hidden /> Pause Borderless
          </Button>
        )}
        <ConfirmButton
          size="sm"
          variant="danger"
          disabled={pending}
          title="Emergency stop?"
          body="Borderless stops immediately: it is paused, automatic purchasing is revoked, and every purchase waiting for your approval is declined unpaid. Payments already settled on Stellar testnet are permanent. You can resume and restore authority from Settings."
          confirmLabel="Stop everything"
          onConfirm={async () => {
            await control("emergency_stop");
          }}
        >
          <OctagonX className="size-3.5" aria-hidden /> Emergency stop
        </ConfirmButton>
      </div>
    </div>
  );
}
