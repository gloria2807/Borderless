"use client";

import { useEffect, useRef, useState } from "react";
import { FastForward, Gauge, Play, RotateCcw, Square, TriangleAlert, X } from "lucide-react";
import { Button, cn } from "@/components/ui/primitives";
import { ConfirmButton, Toggle, useApiAction } from "@/components/ui/interactive";
import { UTILITY_NAMES } from "@/lib/format";

type Kind = "electricity" | "airtime" | "data";

interface Props {
  utilities: { kind: Kind; multiplier: number; providerAvailable: boolean }[];
  faults: { key: string; label: string; enabled: boolean }[];
  simNow: string;
  compact?: boolean;
}

const SPEEDS = [0.5, 1, 2, 3, 5];

/**
 * Operator panel for the demo: move simulated time, change usage, inject failures,
 * reset. Everything here is clearly a demo control, not a household feature.
 */
export function DemoControls({ utilities, faults, compact }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const { run, pending } = useApiAction();
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);

  // Live mode: one simulated hour per tick; Borderless re-assesses after each.
  useEffect(() => {
    liveRef.current = live;
    if (!live) return;
    let cancelled = false;
    (async () => {
      while (!cancelled && liveRef.current) {
        const r = await run<{ agent?: { outcome: string } }>("/api/simulation/advance", { body: { hours: 1, runAgent: true } });
        if (!r.ok) {
          setLive(false);
          break;
        }
        await new Promise((res) => setTimeout(res, 2500));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [live, run]);

  const advance = (hours: number) =>
    run<{ agent?: { headline: string } | null }>("/api/simulation/advance", { body: { hours, runAgent: true } }, {
      success: (d) => ({ title: `${hours} simulated hour${hours === 1 ? "" : "s"} passed`, body: d.agent ? `Borderless: ${d.agent.headline}` : undefined }),
    });

  return (
    <>
      {compact ? (
        <Button size="sm" variant="secondary" onClick={() => ref.current?.showModal()} aria-label="Open demo controls">
          <Gauge className="size-3.5" /> Demo
        </Button>
      ) : (
        <Button variant="secondary" size="sm" className="w-full justify-start" onClick={() => ref.current?.showModal()}>
          <Gauge className="size-3.5 text-fg-3" /> Demo controls
          {live && <span className="ml-auto size-1.5 animate-pulse-dot rounded-full bg-green" aria-label="Live simulation running" />}
        </Button>
      )}

      <dialog
        ref={ref}
        aria-label="Demo controls"
        className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-[min(400px,100vw)] border-l border-line bg-bg-2 p-0 text-fg backdrop:bg-black/50"
        onClick={(e) => e.target === ref.current && ref.current?.close()}
      >
        <div className="flex h-full flex-col">
          <header className="flex items-start justify-between border-b border-line-soft px-5 py-4">
            <div>
              <h2 className="text-base font-semibold">Demo controls</h2>
              <p className="mt-0.5 text-[13px] text-fg-3">Operate the simulated household. Payments remain real testnet transactions.</p>
            </div>
            <button className="text-fg-3 hover:text-fg" aria-label="Close" onClick={() => ref.current?.close()}>
              <X className="size-4" />
            </button>
          </header>

          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
            <section>
              <h3 className="text-[13px] font-semibold">Simulated time</h3>
              <p className="mt-0.5 text-[13px] text-fg-3">Usage drains each device; Borderless re-assesses after each step.</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[1, 6, 24].map((h) => (
                  <Button key={h} size="sm" disabled={pending || live} onClick={() => advance(h)}>
                    <FastForward className="size-3.5" /> {h}h
                  </Button>
                ))}
              </div>
              <div className="mt-2">
                <Button size="sm" variant={live ? "danger" : "secondary"} className="w-full" onClick={() => setLive((v) => !v)}>
                  {live ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                  {live ? "Stop live simulation" : "Run live: 1 hour every few seconds"}
                </Button>
              </div>
            </section>

            <section>
              <h3 className="text-[13px] font-semibold">Usage speed</h3>
              <p className="mt-0.5 text-[13px] text-fg-3">Multiplies normal consumption. Use 3× on data to show unusual usage.</p>
              <div className="mt-3 space-y-2.5">
                {utilities.map((u) => (
                  <div key={u.kind} className="flex items-center justify-between gap-3">
                    <span className="text-[13px] text-fg-2">{UTILITY_NAMES[u.kind]}</span>
                    <div role="radiogroup" aria-label={`${UTILITY_NAMES[u.kind]} usage speed`} className="flex rounded-md border border-line p-0.5">
                      {SPEEDS.map((sp) => (
                        <button
                          key={sp}
                          role="radio"
                          aria-checked={u.multiplier === sp}
                          disabled={pending}
                          onClick={() => run("/api/simulation/usage", { body: { kind: u.kind, multiplier: sp } })}
                          className={cn("mono h-6 rounded-sm px-2 text-2xs", u.multiplier === sp ? "bg-raised text-fg" : "text-fg-3 hover:text-fg")}
                        >
                          {sp}×
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <TriangleAlert className="size-3.5 text-amber" /> Failure injection
              </h3>
              <p className="mt-0.5 text-[13px] text-fg-3">Exercise the failure paths. Nothing is faked: failures happen in the real flow.</p>
              <div className="mt-3 space-y-3">
                {faults.map((f) => (
                  <label key={f.key} className="flex items-center justify-between gap-3">
                    <span className="text-[13px] text-fg-2">{f.label}</span>
                    <Toggle checked={f.enabled} label={f.label} disabled={pending} onChange={(v) => run("/api/demo/faults", { body: { fault: f.key, enabled: v } })} />
                  </label>
                ))}
                {utilities.map((u) => (
                  <label key={`out-${u.kind}`} className="flex items-center justify-between gap-3">
                    <span className="text-[13px] text-fg-2">{UTILITY_NAMES[u.kind]} provider outage</span>
                    <Toggle checked={!u.providerAvailable} label={`${UTILITY_NAMES[u.kind]} provider outage`} disabled={pending} onChange={(v) => run("/api/demo/faults", { body: { providerOutage: u.kind, enabled: v } })} />
                  </label>
                ))}
              </div>
            </section>
          </div>

          <footer className="border-t border-line-soft px-5 py-4">
            <ConfirmButton
              variant="danger"
              size="sm"
              title="Reset the demo household?"
              body="Balances, budget, decisions and purchase history return to the starting scenario. Testnet transactions already on Stellar are permanent and are not affected."
              confirmLabel="Reset demo"
              loading={pending}
              onConfirm={async () => {
                setLive(false);
                await run("/api/demo/reset", {}, { success: () => ({ title: "Demo household reset" }) });
              }}
            >
              <RotateCcw className="size-3.5" /> Reset demo household
            </ConfirmButton>
          </footer>
        </div>
      </dialog>
    </>
  );
}
