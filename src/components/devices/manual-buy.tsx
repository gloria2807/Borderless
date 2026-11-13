"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/primitives";
import { useApiAction } from "@/components/ui/interactive";
import { naira, UTILITY_NAMES } from "@/lib/format";

interface Option { value: string; label: string; amountNgn: number }

/**
 * Owner-initiated top-up. Goes through exactly the same budget checks and x402
 * payment path as the agent — it is not a shortcut around the rules.
 */
export function ManualBuy({ kind, options, disabledReason }: { kind: "electricity" | "airtime" | "data"; options: Option[]; disabledReason?: string | null }) {
  const id = useId();
  const [choice, setChoice] = useState(options[1]?.value ?? options[0]?.value ?? "");
  const { run, pending } = useApiAction();
  const selected = options.find((o) => o.value === choice);

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!selected) return;
        run<{ stage: string; failureMessage?: string }>(
          "/api/purchases",
          { body: kind === "data" ? { kind, productCode: selected.value } : { kind, amountNgn: selected.amountNgn } },
          {
            success: (d) =>
              d.stage === "completed"
                ? { title: `${UTILITY_NAMES[kind]} bought`, body: `${selected.label} paid on Stellar testnet and released to the device.` }
                : { title: "Purchase needs attention", body: d.failureMessage ?? "Open Transactions for details." },
            errorTitle: `Couldn't buy ${UTILITY_NAMES[kind].toLowerCase()}`,
          },
        );
      }}
    >
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="label">
          Top up yourself
        </label>
        <select
          id={id}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="mt-1.5 h-8 w-full rounded-lg border border-line bg-raised px-2 text-[13px] text-fg"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {kind === "data" ? `, ${naira(o.amountNgn)}` : ""}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" size="sm" loading={pending} disabled={!!disabledReason} title={disabledReason ?? undefined}>
        Buy
      </Button>
    </form>
  );
}
