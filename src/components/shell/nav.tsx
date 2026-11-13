"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type LucideIcon, Cable, House, LayoutGrid, ListChecks, Network, ReceiptText, SlidersHorizontal } from "lucide-react";
import { cn } from "@/components/ui/primitives";

type NavItem = { href: string; label: string; icon: LucideIcon };
const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Household",
    items: [
      { href: "/overview", label: "Overview", icon: LayoutGrid },
      { href: "/household", label: "Household", icon: House },
      { href: "/accounts", label: "Accounts", icon: Cable },
    ],
  },
  {
    label: "Agent",
    items: [
      { href: "/agent", label: "Agent", icon: ListChecks },
      { href: "/providers", label: "Providers", icon: Network },
      { href: "/transactions", label: "Transactions", icon: ReceiptText },
    ],
  },
  { label: "Control", items: [{ href: "/settings", label: "Settings", icon: SlidersHorizontal }] },
];

const ITEMS = GROUPS.flatMap((g) => g.items);

const isActive = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

function Badge({ n }: { n: number }) {
  return (
    <span className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-soft px-1.5 text-[10.5px] font-semibold text-amber tabular" aria-label={`${n} need attention`}>
      {n}
    </span>
  );
}

export function SideNav({ badges }: { badges: Partial<Record<string, number>> }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="space-y-5">
      {GROUPS.map((g) => (
        <div key={g.label}>
          <p className="label mb-1.5 px-2" aria-hidden>
            {g.label}
          </p>
          <ul className="space-y-px">
            {g.items.map(({ href, label, icon: Icon }) => {
              const active = isActive(path, href);
              const badge = badges[href];
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium transition-colors duration-150",
                      active ? "bg-fg/[0.06] text-fg" : "text-fg-2 hover:bg-fg/[0.04] hover:text-fg",
                    )}
                  >
                    <Icon className={cn("size-[15px]", active ? "text-fg" : "text-fg-3")} strokeWidth={1.8} aria-hidden />
                    {label}
                    {!!badge && <Badge n={badge} />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function TopNav({ badges }: { badges: Partial<Record<string, number>> }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2.5 [scrollbar-width:none]">
      {ITEMS.map(({ href, label }) => {
        const active = isActive(path, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn("flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium", active ? "bg-ink text-white" : "text-fg-2 hover:bg-fg/[0.05]")}
          >
            {label}
            {!!badges[href] && <span className={cn("rounded-full px-1.5 text-2xs font-semibold", active ? "bg-white/20 text-white" : "bg-amber-soft text-amber")}>{badges[href]}</span>}
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
