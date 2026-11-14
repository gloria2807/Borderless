# Borderless — implementation status

Maintained against the "Product completion, autonomous agent engineering and demo readiness" brief.
Status words: **Verified** (works, tested or proven live) · **Partial** · **Present, not working** · **Missing** · **Blocked** (external dependency).

## 1. Original state discovered (audit, 13 Nov 2026)

Borderless was already a working product, built in milestones M0–M7, the procurement amendment (A1–A5) and the design refinement:

| Area | State found | Evidence |
| --- | --- | --- |
| x402 purchase on Stellar testnet | **Verified.** Provider endpoints answer HTTP 402; the buyer validates the requirements against the quote, policy re-checks before signing, the facilitator settles, the provider confirms on Horizon and only then releases. Many live settlements. | `payments/x402-buyer.ts`, `providers/purchase-handler.ts`, `tests/payment-flow.test.ts` |
| Payment vs fulfilment | **Verified.** Separate statuses, receipts, idempotency keys, one settlement per payment, retry-release without re-paying, reconciliation sweep. | `transactions/*`, `tests/resilience.test.ts` |
| Policy engine | **Verified**, in naira of household value: 11 ordered checks incl. per-request, task, daily, period, wallet balance, quote validity, approval. | `household/policy.ts` |
| Approvals | **Verified.** Bound to exact terms (hash), expiry, decline; agent cannot approve. | `transactions/approvals.ts` |
| Decision engine | **Verified.** Forecasts, priorities, budget sharing, deferrals with reasons, options considered, value-of-information. | `agent/engine.ts` |
| AI agent + deterministic planner | **Verified.** Typed, validated tools; run log; SSE console. | `agent/runtime/*` |
| Provider network | **Verified.** Registry, published service documents, payee verification, free vs paid endpoints, two diagnostic services. | `providers/catalog.ts` |
| Demo scenarios and faults | **Verified.** 14 scenarios, failure injection, reset. | `demo/*` |
| Frontend | **Verified.** Light design system, all pages, landing page. | `docs/design-refinement-plan.md` |

## 2. Gap analysis against the brief

| Requirement | Before | Action |
| --- | --- | --- |
| Household persona with exact USDC limits (10 / 4 / 2, approval above 2) | **Partial** — limits existed in naira at ₦100,000 per test USDC, so purchases were ~0.02 USDC and the persona's USDC values had no meaning | Fixed demo rate ₦1,000 = 1 test USDC; persona defaults; limits shown and edited in USDC |
| Show budget vs daily vs task vs per-request vs wallet vs pending vs spendable | **Partial** | Spending-authority breakdown from one server function |
| Simulate Low Balance (backend, persisted, triggers the agent, repeatable) | **Missing** | Build |
| Primary electricity demo (Scenario A) | **Partial** — the flow works; no dedicated, repeatable entry point | Scenario + Simulate Low Balance + live proof |
| 2 USDC competing needs (Scenario B) with the 8-point explanation | **Partial** — "Budget covers only one" existed | Align to persona, structured explanation, tests across priorities |
| Policy rejection demo (Scenario C) | **Partial** — tested in code, no demo path | Build |
| Failure handling (Scenario D) | **Verified** | Keep; re-verify |
| Pause / resume / emergency stop | **Partial** — revoke existed; no pause or stop | Build |
| Electricity eligibility (meter tied to one DisCo) | **Missing** — two electricity vendors with no notion of DisCo, and different per-kWh prices | One eligibility rule in the registry; vendors become authorised channels for the meter's DisCo at its tariff, differing only by fee and amounts |
| Airtime/data network constraints | **Partial** — approved networks enforced | Make eligibility explicit in discovery |
| Tools `read_price_list`, `search_offers`, `evaluate_purchase`, `buy_service`, `discover_services` | **Partial** — equivalents under other names | Rename / add |
| Mentor check-in, operator checklist, testnet guide | **Missing** | Write |
| Testnet USDC sustainability | **Partial** | Recycle script returning provider receipts to the agent wallet |

## 3. What changed in this phase

**Improved**
- **Persona and currency.** Fixed demo rate ₦1,000 = 1 test USDC (`DEMO_NGN_PER_TESTNET_USDC`, default `1000`). "Okafor Household", owner Adaeze Okafor (shown together in the sidebar, Overview and Settings): 2 USDC automatic per request, approval above 2, 4 USDC per request maximum, 4 per task, 10 per day, 60 per period, 100 USDC monthly budget. Policy checks state amounts in USDC. (`household/seed.ts`, `household/policy.ts`)
- **Settings** edit every limit in USDC, with an explicit provider allowlist showing eligibility. (`components/settings/settings-form.tsx`, `server/settings.ts`)
- **Electricity realism.** Both electricity vendors are authorised channels for the meter's DisCo ("Demo Eko DisCo", simulated) at its tariff; they differ by service fee (₦100 vs none) and denominations, not by inventing a cheaper tariff. Published in each service document. (`providers/electricity.ts`)
- **Tools** renamed to the brief's vocabulary: `discover_services`, `evaluate_purchase`, `buy_service`; old run logs still read correctly. (`agent/runtime/tools.ts`, `views/runs.ts`)
- **Deterministic planner** now discovers over HTTP (`discover_services`, `search_offers`) for each utility that needs attention before deciding, and states each purchase's real outcome first in its summary.
- **Explanations** show test-USDC equivalents next to naira.
- **Approval card**: purchase, provider, USDC amount, the agent's reason (from its run log), budget after, live expiry countdown, exact terms.
- **Overview**: electricity first (meter, DisCo, units, time left, usage, latest purchase), live agent status, Simulate low balance, Reset demo, and the spending-authority breakdown.

**Newly implemented**
- **Eligibility rule** (`providers/registry.ts → eligibilityFor`): a meter only through vendors authorised for its DisCo; airtime and data only on the line's own network. Used by the engine, the tools, Providers and Settings. Discovery lists ineligible providers with the reason instead of hiding them.
- **`read_price_list`** and **`search_offers`** tools (prices in naira and test USDC, eligible offers only, exclusions explained).
- **Owner controls** (`agent/control.ts`, `POST /api/agent/control`): pause (no runs, no assessments, an in-flight run stops at its next tool call, policy check 0 refuses), resume, emergency stop (pause + revoke + decline pending approvals). No agent tool can reach them.
- **Simulate low balance** (`demo/low-balance.ts`, `POST /api/demo/low-balance`): lowers the persisted meter to about a day of supply, records it, starts a real deterministic agent run. Lower-only and repeatable.
- **Scenarios A–D** (`demo/scenarios.ts`): A primary electricity (now the default clean start), B competing needs (2 USDC left), C spending-limit rejection (`POST /api/demo/over-limit` instructs the agent to buy 5 USDC through its normal tools), D paid-but-not-delivered.
- **Spending authority view** (`views/authority.ts`): household budget, period authority, daily budget, per-task, per-request limits, pending commitments, live wallet balance and what is spendable now, with the binding constraint named.
- **`pnpm wallets:recycle`**: returns the test USDC demo providers received to the agent wallet.
- Docs: `docs/mentor-check-in.md` (script and operator checklist), README "Testnet setup" and "The household owner".

**Architecture decisions**
- Policy limits stay stored as naira of household value; at an integer demo rate every USDC limit maps exactly (2 USDC = ₦2,000), and the signed amount is independently checked in atomic USDC against the quote before signing. This avoided rewriting a verified policy engine.
- Payment-mechanics tests keep their original limits through an explicit helper (`tests/helpers.ts → MECHANICS_TEST_LIMITS`); the shipped persona has its own suite (`tests/persona-policy.test.ts`).
- Scenario C uses the deterministic planner with an operator directive, so the refusal comes from the same tools and policy engine as any purchase, not a staged message.

## 4. Live proof on Stellar testnet (14 Nov 2026)

| Scenario | Result | Transaction |
| --- | --- | --- |
| A · Simulate low balance | 2.0000000 USDC from the agent wallet (GAT3…XCJV) to Demo PowerGrid Vend's registered payee (GDTQ…A3JC); provider verified, units released, meter credited, receipt issued. Confirmed independently on Horizon (ledger 5721765). | `a8916cba985e6221b753872c42e1f2127634ac9513d552c573458c5302ce27ed` |
| B · 2 USDC left | Bought 2 USDC of electricity, deferred data with reasons; payment confirmed, released. | `b68e6c743899992df5c4c39ba75fb540c1d70035c5c72ddf1db13a8dff752aee` |
| C · Over-limit | Refused before signing: above the 4 USDC per-request maximum and the 4 USDC task budget. No purchase, no payment. | none (by design) |
| D · Release fails | Payment confirmed, release failed (recorded separately); Retry release completed it against the same transaction, no second payment. | `3a579d133e4ace3225e4e8d271f350272fee2f16a2e4ab562752b0b8991cb92d` |

`pnpm wallets:recycle` returned 3.56 test USDC from provider wallets to the agent (8 real testnet payments).

## 5. Tests

- `pnpm check`: typecheck + **316** unit/integration tests, all passing (24 new in `tests/persona-policy.test.ts`: persona limits, per-request/task/daily/wallet/provider/revocation/pause checks, Scenarios A–C, owner controls, eligibility, the new tools).
- `pnpm test:e2e`: Playwright incl. axe accessibility and mobile; 4 new tests in `tests/e2e/owner-controls.spec.ts` (pause/simulate/resume, emergency stop, Scenario C through the UI, Settings in USDC). **34 passed**, 1 skipped (the opt-in live-payment spec).
- Live testnet runs above.

## 6. External dependencies

Stellar testnet (Horizon, Soroban RPC), the public x402 facilitator (`https://x402.org/facilitator`), Friendbot and the Circle testnet faucet for funding, and optionally the Gemini API for AI-mode runs (free tier: 20 requests per model per day). The primary demo uses the deterministic planner and doesn't depend on Gemini.

## 7. Known limitations

- Utilities, devices, providers, DisCo and tariff are simulated and labelled as such; no real DisCo or network is integrated.
- The AI planner was not re-run live in this phase (Gemini free-tier quota); its tools and prompt are covered by the scripted-model tests.
- Agent wallet funding is testnet USDC; if the faucet and DEX are both unavailable, live purchases fail honestly ("not charged").
- Policy limits are stored in naira of household value and displayed in USDC at the fixed demo rate (see Architecture decisions).

## 8. Commands

```bash
pnpm install
cp .env.example .env.local
pnpm wallets:setup
pnpm db:reset
pnpm dev
```

Primary demo: open `http://localhost:3000/overview` → **Reset demo** → **Simulate low balance** → watch the run → open the purchase → **Inspect procurement** → **Request without paying**. Before presenting: `pnpm wallets:status` (≥ 8 USDC), `pnpm wallets:recycle` if low. Full checklist: `docs/mentor-check-in.md`.
