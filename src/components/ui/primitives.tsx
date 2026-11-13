import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import { TONE_BG, TONE_TEXT, type Tone } from "@/lib/status";

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

// ── Button ──────────────────────────────────────────────────────────────────
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "dark" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
};

export function Button({ variant = "secondary", size = "md", loading, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-3 text-[12.5px]" : "h-9 px-4 text-[13px]",
        variant === "primary" && "bg-green text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] hover:bg-green-hover",
        variant === "dark" && "bg-ink text-white hover:bg-ink-2",
        variant === "secondary" && "bg-raised text-fg shadow-ring hover:bg-bg-2",
        variant === "ghost" && "text-fg-2 hover:bg-fg/[0.06] hover:text-fg",
        variant === "danger" && "bg-raised text-coral shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-coral)_35%,transparent)] hover:bg-coral-soft",
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent", className)}
    />
  );
}

// ── Status ──────────────────────────────────────────────────────────────────
export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", TONE_BG[tone], pulse && "animate-pulse-dot")} />;
}

export function StatusPill({ tone, children, pulse, title }: { tone: Tone; children: ReactNode; pulse?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap",
        tone === "positive" && "bg-green-soft",
        tone === "warning" && "bg-amber-soft",
        tone === "critical" && "bg-coral-soft",
        tone === "info" && "bg-cyan-soft",
        (tone === "neutral" || tone === "progress") && "bg-fg/[0.06]",
        TONE_TEXT[tone],
      )}
    >
      <Dot tone={tone} pulse={pulse ?? tone === "progress"} />
      {children}
    </span>
  );
}

/** Marks anything simulated. Used on every virtual device and demo value. */
export function SimulatedTag({ children = "Simulated" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-fg/[0.05] px-2 py-0.5 text-2xs font-medium text-fg-3">
      <FlaskConical className="size-3" aria-hidden />
      {children}
    </span>
  );
}

export function TestnetTag() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-soft px-2 py-0.5 text-2xs font-medium text-cyan">
      <span aria-hidden className="size-1.5 rounded-full bg-cyan" />
      Stellar testnet
    </span>
  );
}

// ── Layout ──────────────────────────────────────────────────────────────────
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  as: Tag = "section",
  ...rest
}: HTMLAttributes<HTMLElement> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  bodyClassName?: string;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag {...rest} className={cn("rounded-lg bg-surface shadow-ring", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[13.5px] font-semibold tracking-[-0.005em] text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-[12.5px] text-fg-3">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </Tag>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: ReactNode; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="label mb-2">{eyebrow}</p>}
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.025em] text-fg">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[13px] text-fg-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function KeyValue({ label, children, mono, className }: { label: ReactNode; children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-2", className)}>
      <dt className="shrink-0 text-[13px] text-fg-3">{label}</dt>
      <dd className={cn("min-w-0 text-right text-[13px] text-fg break-all", mono && "mono")}>{children}</dd>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-fg-3">{icon}</div>}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {children && <p className="mt-1 max-w-sm text-[13px] text-fg-3">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Meter({ value, tone, label }: { value: number; tone: Tone; label: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="h-1.5 w-full overflow-hidden rounded-full bg-fg/[0.07]">
      <div className={cn("h-full rounded-full transition-[width] duration-700", TONE_BG[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Recur-style structure ───────────────────────────────────────────────────
/** Mono, uppercase, wide-tracked section label. Organises a page without shouting. */
export function SectionLabel({ children, className, as: Tag = "h2", aside }: { children: ReactNode; className?: string; as?: "h2" | "h3" | "p"; aside?: ReactNode }) {
  return (
    <div className={cn("mb-2.5 flex min-h-6 items-center justify-between gap-3", className)}>
      <Tag className="label">{children}</Tag>
      {aside}
    </div>
  );
}

/** One strip of headline figures with hairline separators (a single `dl`). */
export function KpiStrip({ items, className }: { items: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone }[]; className?: string }) {
  return (
    <dl
      className={cn("grid overflow-hidden rounded-lg bg-surface shadow-ring", className)}
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))" }}
    >
      {items.map((it, i) => (
        <div key={i} className="px-4 py-3.5 shadow-[-1px_-1px_0_0_rgb(12_13_12/0.07)]">
          <dt className="text-[11.5px] text-fg-3">{it.label}</dt>
          <dd className={cn("mt-1 text-[22px] leading-7 font-semibold tracking-[-0.03em] tabular", it.tone ? TONE_TEXT[it.tone] : "text-fg")}>{it.value}</dd>
          {it.hint && <dd className="mt-0.5 text-[11.5px] text-fg-3">{it.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Quiet "live" chip with a dot, shown only for genuinely live states. */
export function LiveChip({ children, live = true, tone = "positive" }: { children: ReactNode; live?: boolean; tone?: Tone }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-bg-2 px-2.5 py-1 text-[11.5px] font-medium text-fg-2">
      <Dot tone={live ? tone : "neutral"} pulse={live} />
      {children}
    </span>
  );
}
