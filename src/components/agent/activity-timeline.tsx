import Link from "next/link";
import { ArrowUpRight, Ban, CircleCheck, Eye, Gauge, Scale, TrendingDown, Wallet } from "lucide-react";
import { clock, dayTime } from "@/lib/format";
import { cn } from "@/components/ui/primitives";
import type { EventView } from "@/server/views/household";

const CATEGORY_ICON = {
  observation: Eye,
  prediction: TrendingDown,
  decision: Scale,
  payment: Wallet,
  fulfilment: CircleCheck,
  system: Gauge,
} as const;

const SEVERITY = {
  info: "text-fg-3",
  success: "text-green",
  warning: "text-amber",
  critical: "text-coral",
} as const;

/** Chronological operational log. Newest first unless `ascending`. */
export function ActivityTimeline({ events, ascending = false, dense = false }: { events: EventView[]; ascending?: boolean; dense?: boolean }) {
  const list = ascending ? [...events].reverse() : events;
  return (
    <ol className="relative">
      {list.map((e, i) => {
        const Icon = e.type === "payment.failed" ? Ban : CATEGORY_ICON[e.category as keyof typeof CATEGORY_ICON] ?? Gauge;
        const last = i === list.length - 1;
        return (
          <li key={e.id} className="relative grid grid-cols-[22px_minmax(0,1fr)] gap-3 pb-4 animate-fade-in">
            {!last && <span aria-hidden className="absolute top-6 bottom-0 left-[10.5px] w-px bg-fg/[0.07]" />}
            <span className={cn("mt-px flex size-[22px] items-center justify-center rounded-full bg-raised shadow-ring", SEVERITY[e.severity])}>
              <Icon className="size-3" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className={cn("text-[13px] font-medium", e.severity === "critical" ? "text-coral" : "text-fg")}>{e.title}</p>
                <time className="mono shrink-0 text-[10.5px] text-fg-3" dateTime={e.simTime} title={`Household time ${dayTime(e.simTime)}`}>
                  {clock(e.simTime)}
                </time>
              </div>
              {/* Decision reasoning lives in the decision log; repeating it here would bury the timeline. */}
              {e.detail && !dense && !e.type.startsWith("decision.") && <p className="mt-0.5 text-[13px] break-words text-fg-3">{e.detail}</p>}
              <div className="mt-1 flex flex-wrap gap-3 empty:hidden">
                {e.explorerUrl && (
                  <a href={e.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-2xs font-medium text-cyan hover:underline">
                    View on Stellar Expert (testnet) <ArrowUpRight className="size-3" aria-hidden />
                  </a>
                )}
                {e.purchaseId && e.category === "decision" && e.type === "purchase.created" && (
                  <Link href={`/transactions/${e.purchaseId}`} className="text-2xs font-medium text-fg-2 hover:text-fg">
                    Open transaction
                  </Link>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
