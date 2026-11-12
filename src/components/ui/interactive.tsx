"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { Button, cn } from "./primitives";

// ── Toasts ──────────────────────────────────────────────────────────────────
type ToastTone = "positive" | "critical" | "info";
interface Toast { id: number; tone: ToastTone; title: string; body?: string }
const ToastContext = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++idRef.current;
    setToasts((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.tone === "critical" ? 9000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className="pointer-events-auto flex animate-fade-in gap-3 rounded-md border border-line bg-raised p-3 shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
            {t.tone === "positive" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green" /> : t.tone === "critical" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-coral" /> : <Info className="mt-0.5 size-4 shrink-0 text-cyan" />}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-fg">{t.title}</p>
              {t.body && <p className="mt-0.5 text-[13px] text-fg-2">{t.body}</p>}
            </div>
            <button aria-label="Dismiss" onClick={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))} className="text-fg-3 hover:text-fg">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Activity broadcast: lets the shell keep refreshing while any action runs ─
const BusyContext = createContext<{ busy: number; begin: () => () => void }>({ busy: 0, begin: () => () => {} });
export const useBusy = () => useContext(BusyContext);

export function BusyProvider({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState(0);
  const begin = useCallback(() => {
    setBusy((n) => n + 1);
    let done = false;
    return () => {
      if (!done) {
        done = true;
        setBusy((n) => n - 1);
      }
    };
  }, []);
  return <BusyContext.Provider value={{ busy, begin }}>{children}</BusyContext.Provider>;
}

/**
 * While an action is running (e.g. an agent run paying two providers), refresh the
 * server-rendered page every ~1.2s so the timeline shows each step as it is persisted.
 */
export function LiveRefresh() {
  const { busy } = useBusy();
  const router = useRouter();
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 1200);
    return () => clearInterval(t);
  }, [busy, router]);
  return null;
}

// ── Actions ─────────────────────────────────────────────────────────────────
export interface ActionResult<T = unknown> { ok: boolean; status: number; data: T }

export function useApiAction() {
  const router = useRouter();
  const toast = useToast();
  const { begin } = useBusy();
  const [pending, setPending] = useState(false);
  const [, startTransition] = useTransition();

  const run = useCallback(
    async <T,>(url: string, init: { method?: string; body?: unknown } = {}, messages: { success?: (d: T) => { title: string; body?: string } | null; errorTitle?: string } = {}): Promise<ActionResult<T>> => {
      setPending(true);
      const end = begin();
      try {
        const res = await fetch(url, {
          method: init.method ?? "POST",
          headers: { "content-type": "application/json" },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        const data = (await res.json().catch(() => ({}))) as T & { message?: string };
        if (!res.ok) {
          toast({ tone: "critical", title: messages.errorTitle ?? "That didn't work", body: data.message ?? `Request failed (HTTP ${res.status}).` });
        } else {
          const msg = messages.success?.(data);
          if (msg) toast({ tone: "positive", ...msg });
        }
        return { ok: res.ok, status: res.status, data };
      } catch (err) {
        toast({ tone: "critical", title: messages.errorTitle ?? "Network error", body: (err as Error).message });
        return { ok: false, status: 0, data: {} as T };
      } finally {
        end();
        setPending(false);
        startTransition(() => router.refresh());
      }
    },
    [begin, router, toast],
  );
  return { run, pending };
}

// ── Toggle ──────────────────────────────────────────────────────────────────
export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
        checked ? "border-green bg-green" : "border-line bg-raised",
      )}
    >
      <span className={cn("inline-block size-3.5 rounded-full transition-transform", checked ? "translate-x-[18px] bg-[#10200f]" : "translate-x-[2px] bg-fg-3")} />
    </button>
  );
}

// ── Confirm dialog ──────────────────────────────────────────────────────────
export function ConfirmButton({
  children,
  title,
  body,
  confirmLabel,
  onConfirm,
  variant = "secondary",
  size,
  loading,
  disabled,
}: {
  children: ReactNode;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  loading?: boolean;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  return (
    <>
      <Button variant={variant} size={size} loading={loading} disabled={disabled} onClick={() => ref.current?.showModal()}>
        {children}
      </Button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="m-auto w-[min(440px,calc(100vw-2rem))] rounded-lg border border-line bg-raised p-0 text-fg backdrop:bg-black/60"
        onClick={(e) => e.target === ref.current && ref.current?.close()}
      >
        <div className="p-5">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <div id={bodyId} className="mt-2 text-[13px] text-fg-2">{body}</div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line-soft px-5 py-3">
          <Button variant="ghost" size="sm" onClick={() => ref.current?.close()}>
            Cancel
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "primary"}
            size="sm"
            onClick={async () => {
              ref.current?.close();
              await onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </dialog>
    </>
  );
}
