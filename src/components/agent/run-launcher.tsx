"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Play } from "lucide-react";
import { Button, cn } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/interactive";

/**
 * Start an agent run. The run continues on the server; this navigates to its live
 * operations view, which streams each persisted step.
 */
export function RunLauncher({ aiAvailable, model, defaultTask }: { aiAvailable: boolean; model: string; defaultTask: string }) {
  const router = useRouter();
  const toast = useToast();
  const [task, setTask] = useState(defaultTask);
  const [mode, setMode] = useState<"ai" | "deterministic">(aiAvailable ? "ai" : "deterministic");
  const [pending, setPending] = useState(false);
  const taskId = useId();
  const group = useId();

  const start = async () => {
    setPending(true);
    try {
      const res = await fetch("/api/agent/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task, mode }) });
      const data = (await res.json().catch(() => ({}))) as { runId?: string; message?: string };
      if (res.status === 409 && data.runId) {
        toast({ tone: "info", title: "A run is already in progress", body: "Showing it now." });
        router.push(`/agent/runs/${data.runId}`);
        return;
      }
      if (!res.ok || !data.runId) {
        toast({ tone: "critical", title: "Couldn't start the run", body: data.message ?? `HTTP ${res.status}` });
        return;
      }
      router.push(`/agent/runs/${data.runId}`);
    } catch (err) {
      toast({ tone: "critical", title: "Network error", body: (err as Error).message });
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <div>
        <label htmlFor={taskId} className="text-[13px] font-medium text-fg-2">
          Task for the agent
        </label>
        <textarea
          id={taskId}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          maxLength={600}
          rows={2}
          className="mt-1.5 w-full resize-y rounded-md border border-line bg-bg-2 px-3 py-2 text-[13px] text-fg outline-none focus:border-green"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset className="inline-flex rounded-md border border-line p-0.5">
          <legend className="sr-only">Planner</legend>
          {(
            [
              ["ai", `AI agent (${model})`],
              ["deterministic", "Deterministic (no AI)"],
            ] as const
          ).map(([value, label]) => {
            const disabled = value === "ai" && !aiAvailable;
            return (
              <label
                key={value}
                title={disabled ? "Add OPENAI_API_KEY to .env.local to enable the AI agent." : undefined}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-green",
                  mode === value ? "bg-raised text-fg" : "text-fg-3",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <input type="radio" name={group} value={value} checked={mode === value} disabled={disabled} onChange={() => setMode(value)} className="sr-only" />
                {value === "ai" && <Bot className="size-3.5" aria-hidden />}
                {label}
              </label>
            );
          })}
        </fieldset>
        <Button type="submit" variant="primary" loading={pending} disabled={!task.trim()}>
          {!pending && <Play className="size-4" aria-hidden />}
          Start run
        </Button>
      </div>
      <p className="text-2xs text-fg-3">
        The agent proposes; fixed code decides. Purchases use real Stellar testnet x402 payments within your spending rules.
      </p>
    </form>
  );
}
