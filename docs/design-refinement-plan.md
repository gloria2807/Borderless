# Borderless — Frontend design refinement: audit and plan

**Status:** implemented (light theme, new tokens and primitives, every app page restyled, landing page at `/`, app Overview moved to `/overview`). Reference studied: the Recur website and its embedded dashboard preview (the live dashboard needs an account; the repositories are private). Borderless keeps its own name, voice and product; it borrows Recur's *discipline*, not its brand.

## 1. Audit

**Worth adopting from Recur**
- Warm off-white canvas with paper-white panels separated by hairline rings rather than heavy borders.
- One dominant typeface at small, tight sizes (13px body, 12.5px rows) and a mono face reserved for labels, timestamps and machine values.
- Mono uppercase section labels (10px, wide tracking, faint) that organise a page without headings shouting.
- A single KPI strip (one `dl`, hairline separators) instead of a grid of equal cards.
- 38px rows with 5% dividers; pills that are small, soft-tinted and fully rounded; a quiet "live" chip with a dot.
- Neutral navigation (ink 6% active state), one strong accent (green) used for primary action and success only.
- Landing: faint grid, two-tone headline, alternating light/dark bands, a sources → agent → outcomes diagram with mono labels.

**Worth preserving in Borderless**
- Semantic status model (`lib/status.ts`: tones, payment vs fulfilment, stage labels) — the honesty of "payment" and "fulfilment" as separate facts.
- Reusable primitives (`Button`, `StatusPill`, `Panel`, `KeyValue`, `EmptyState`, `Meter`), `interactive.tsx` (toasts, `useApiAction`, `ConfirmButton`), the run console's SSE handling, the procurement inspection and "Request without paying".
- The service-runway chart, the device mock-ups (meter, phone) as the "Household" metaphor, plain-language copy.

**Problems found**
- Dark theme with many equal-weight panels: weak hierarchy, every page reads as one long stack of boxes.
- The Overview headline is coral and alarming even when the household is fine; the activity feed is coral-heavy.
- Hard-coded colours in seven components bypass the tokens (`#10200f`, `#b8df76`, meter LCD hexes, black dialog backdrops).
- Agent page: launcher, recent runs, decisions and a long authority list compete; the live run console is the product's best story but is not framed as one.
- Providers page: long service documents dominate; verification and "free vs paid" are hard to scan.
- Transactions: a strong table, but status pills are loud and the KPI cards are oversized for their content.
- Settings: good structure; the sticky save bar and section rhythm can be cleaner.
- Mobile: top nav scrolls horizontally (acceptable) but the Demo button and date crowd the header; panels are fine.
- No landing page: a judge lands directly in the app with no framing of what is real (x402, Stellar testnet) and what is simulated.

## 2. Design system

**Theme:** light (founder decision). Tokens live in `src/app/globals.css` (`@theme`); no component uses a raw hex.

| Token | Value | Use |
| --- | --- | --- |
| `bg` | `#F4F3EE` | canvas |
| `bg-2` | `#EEECE5` | sunken areas, table heads |
| `surface` | `#FBFAF7` | panels |
| `raised` | `#FFFFFF` | inputs, popovers |
| `line` / `line-soft` | ink 10% / ink 6% | rings, dividers |
| `fg` / `fg-2` / `fg-3` / `fg-4` | `#0C0D0C` / `#4A4E49` / `#5F635C` / `#A3A69E` | text hierarchy (fg-4 decorative only) |
| `green` / `green-soft` | `#0E8A55` / `#DCF0E4` (text `#0A6A41`) | primary action, success |
| `amber` / `amber-soft` | `#9A6400` / `#FBEFD5` | warning, needs attention |
| `coral` / `coral-soft` | `#C2412D` / `#FBE3DD` | error, critical |
| `cyan` / `cyan-soft` | `#0B6E80` / `#DDF0F3` | information, in progress |
| `ink` | `#0C0D0C` | dark bands, dark buttons |

All text tones meet WCAG AA on `surface` and on their soft backgrounds.

**Type:** Manrope stays (it gives Borderless its own voice next to Recur's Inter) at Recur's sizes: 13px base, 12.5px rows, 11.5px meta; headings 600 with negative tracking. IBM Plex Mono for labels, amounts in tables, hashes and timestamps.

**Shape and depth:** radius 6 (controls) / 8 (pills-in-cards, inputs) / 12 (panels); panels use a 1px ink ring plus a 1px soft shadow; no glows.

**Components:** `Button` (primary green, dark, secondary outline, ghost, danger), `StatusPill` (soft fill, small dot), `LiveChip`, `SectionLabel`, `Panel` (+ header slot), `KpiStrip`, `Row`/table styles, inputs/selects, toggle, dialog, toast, empty/loading/error states.

**Motion:** 150–200ms colour/opacity transitions; a pulsing dot only on genuinely live states; stage transitions in the run console fade in as events arrive. All disabled under `prefers-reduced-motion`.

## 3. Pages

- **Landing (`/`)** — new. The app's Overview moves to `/overview`. Persuasive but provable: what Borderless does, how a purchase works (observe → discover → 402 → policy → settle on Stellar testnet → receive → act), what is real and what is simulated, a link into the live demo.
- **Overview** — one calm status sentence (tone follows reality), KPI strip (runway, budget left, spent, pending approvals), runway chart, approvals first when present, then activity and latest decision.
- **Agent Operations** — the live run console is the hero: stage rail driven by SSE events only, current step, tool calls and payments as rows; launcher compact; authority summarised with a link to Settings.
- **Household** — devices as quiet cards in light; meter LCD re-tinted; top-up forms secondary.
- **Providers** — table-like provider cards: verification, availability, approval as pills; endpoints in a compact free/paid list; "How Borderless buys" as a two-column comparison.
- **Transactions** — KPI strip, filter bar, 38px rows; detail page with procurement inspection as a vertical step list.
- **Settings** — section labels, two-column rows, sticky save bar.
- **Approval** — exact terms (amount, provider, what's released, expiry countdown) with approve/decline, consistent wherever it appears.

## 4. Order of work

1. Tokens, fonts, base styles, primitives; remove hard-coded colours.
2. Shell (nav, header), Overview, Agent and run console, Household, Providers, Transactions, Settings, approvals.
3. Verify data and SSE paths unchanged.
4. Landing page and route move.
5. Typecheck, unit tests, e2e (selectors and routes updated), axe, mobile.
