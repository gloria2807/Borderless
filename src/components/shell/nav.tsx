"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Cable, House, LayoutGrid, ListChecks, ReceiptText, SlidersHorizontal } from "lucide-react";
import { cn } from "@/components/ui/primitives";

const ITEMS = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/agent", label: "Agent", icon: ListChecks },
  { href: "/household", label: "Household", icon: House },
  { href: "/accounts", label: "Accounts", icon: Cable },
  { href: "/transactions", label: "Transactions", icon: ReceiptText },
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
] as const;

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

export function SideNav({ badges }: { badges: Partial<Record<string, number>> }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = isActive(path, href);
        const badge = badges[href];
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
              active ? "bg-raised text-fg" : "text-fg-2 hover:bg-surface hover:text-fg",
            )}
          >
            {active && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-green" />}
            <Icon className={cn("size-4", active ? "text-green" : "text-fg-3")} aria-hidden />
            {label}
            {!!badge && (
              <span className="ml-auto rounded-sm bg-amber-soft px-1.5 text-2xs font-semibold text-amber" aria-label={`${badge} need attention`}>
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

export function TopNav({ badges }: { badges: Partial<Record<string, number>> }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-px">
      {ITEMS.map(({ href, label }) => {
        const active = isActive(path, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn("flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium", active ? "border-green text-fg" : "border-transparent text-fg-2")}
          >
            {label}
            {!!badges[href] && <span className="rounded-sm bg-amber-soft px-1 text-2xs font-semibold text-amber">{badges[href]}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

export function BrandMark({ className }: { className?: string }) {
  // An open square: a boundary with a gap — the household, without borders.
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="19" cy="5" r="2.2" fill="currentColor" />
    </svg>
  );
}
