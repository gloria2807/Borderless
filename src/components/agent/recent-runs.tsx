import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { EmptyState, StatusPill } from "@/components/ui/primitives";
import type { Tone } from "@/lib/status";
import type { RunSummaryView } from "@/server/views/runs";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "progress" },
  completed: { label: "Completed", tone: "positive" },
  failed: { label: "Failed", tone: "critical" },
  interrupted: { label: "Interrupted", tone: "warning" },
};

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Lagos" });

export function RecentRuns({ runs }: { runs: RunSummaryView[] }) {
  if (!runs.length) return <EmptyState title="No runs yet">Start a run to see the agent work step by step.</EmptyState>;
  return (
    <ul className="divide-y divide-line-soft">
      {runs.map((r) => {
        const st = STATUS[r.status] ?? { label: r.status, tone: "neutral" as Tone };
        return (
          <li key={r.id}>
            <Link href={`/agent/runs/${r.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-raised/40">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <StatusPill tone={st.tone} pulse={r.status === "running"}>
                    {st.label}
                  </StatusPill>
                  <span className="text-2xs text-fg-3">
                    {r.mode === "ai" ? "AI" : "Deterministic"} · {when(r.startedAt)}
                  </span>
                </div>
                <p className="mt-1 truncate text-[13px] text-fg-2">{r.summary ?? r.task}</p>
                <p className="text-2xs text-fg-3">
                  {r.steps} steps · {r.purchaseCount} purchase{r.purchaseCount === 1 ? "" : "s"}
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-fg-3" aria-hidden />
              <span className="sr-only">Open run</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
