import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import { TONE_BG, TONE_TEXT, type Tone } from "@/lib/status";

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

// ── Button ──────────────────────────────────────────────────────────────────
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
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
        "inline-flex items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-9 px-4 text-sm",
        variant === "primary" && "bg-green text-[#10200f] hover:bg-[#c7e88e] active:bg-[#a6cc66]",
        variant === "secondary" && "border border-line bg-raised text-fg hover:border-fg-3 hover:bg-[#21302a]",
        variant === "ghost" && "text-fg-2 hover:bg-raised hover:text-fg",
        variant === "danger" && "border border-coral/40 bg-coral-soft text-coral hover:border-coral/70",
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
        "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 text-xs font-semibold whitespace-nowrap",
        tone === "positive" && "border-green/25 bg-green-soft",
        tone === "warning" && "border-amber/25 bg-amber-soft",
        tone === "critical" && "border-coral/25 bg-coral-soft",
        tone === "info" && "border-cyan/20 bg-cyan-soft",
        (tone === "neutral" || tone === "progress") && "border-line bg-raised",
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
    <span className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 text-2xs font-medium text-fg-3">
      <FlaskConical className="size-3" aria-hidden />
      {children}
    </span>
  );
}

export function TestnetTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-cyan/25 bg-cyan-soft px-1.5 py-0.5 text-2xs font-medium text-cyan">
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
    <Tag {...rest} className={cn("rounded-lg border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-fg-3">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </Tag>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-bold tracking-[-0.01em] text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[13px] text-fg-2">{description}</p>}
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
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
      <div className={cn("h-full rounded-full transition-[width] duration-700", TONE_BG[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}
