# Borderless

**An autonomous household resource procurement agent.** *Your household stays powered and connected. Borderless handles the rest.*

Borderless keeps a household's electricity, airtime and mobile data running. It observes what the household needs, **discovers machine-accessible providers, compares their offers, decides whether information is worth buying before buying a utility, and pays each provider through x402 on Stellar testnet** — then verifies what it received and reassesses. An AI agent plans the work; deterministic code decides what money may move.

**Remove the payment and Borderless stops working.** Utility credit and paid information (such as a meter diagnostic) are released only by providers' x402-protected endpoints after a payment settles. Without paying, a provider answers HTTP 402 and releases nothing — every purchase page has a **Request without paying** button that shows this live.

> **Testnet and simulation.** Every payment is a real transaction on **Stellar testnet** using **test USDC**, which has **no monetary value**. Electricity, airtime and data are **simulated**: the meter and phone are virtual devices, the providers are demo services, and demo electricity tokens are not valid on any physical meter. Budgets are in naira; a fixed, labelled demo rate maps naira to test USDC — it is not an exchange rate.

```
Task → the AI agent observes the household (real state) → forecasts → compares providers and quotes
→ proposes a purchase → POLICY ENGINE (code) allows / asks the owner / refuses
→ provider answers HTTP 402 → payment signed server-side → facilitator settles on Stellar testnet
→ provider releases the simulated utility → independent Horizon check → agent verifies and reassesses
```

**The AI proposes. The code decides.** The model chooses which tools to use and what to buy. It never supplies an amount, a payee, a limit or an approval: purchases can only redeem a quote a provider issued in this run, and every payment is checked by the policy engine — once when proposed and again, with live wallet evidence, immediately before signing.

---

## Contents

- [Quick start](#quick-start)
- [Running the demo](#running-the-demo)
- [The agent](#the-agent)
- [Procurement: provider network and paid information](#procurement-provider-network-and-paid-information)
- [How a purchase works](#how-a-purchase-works)
- [Spending policy](#spending-policy)
- [Approvals](#approvals)
- [Funding guard (on-chain allowance)](#funding-guard-on-chain-allowance)
- [How Borderless decides](#how-borderless-decides)
- [Architecture](#architecture)
- [Commands](#commands)
- [Testing](#testing)
- [Configuration](#configuration)
- [Security notes](#security-notes)
- [Failure handling](#failure-handling)
- [x402 and MPP](#x402-and-mpp)
- [Procurement acceptance criteria](#procurement-acceptance-criteria)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

---

## Quick start

**Prerequisites:** Node.js 22.23.4 or later (developed on Node 24), pnpm 10, and internet access to Stellar testnet. A Gemini API key (default) or an OpenAI API key is needed for the AI agent; everything else (including a deterministic planner) works without one.

```bash
pnpm install
cp .env.example .env.local     # add GEMINI_API_KEY (or OPENAI_API_KEY) for the AI agent
pnpm wallets:setup             # creates and funds the testnet wallets, writes keys to .env.local
pnpm db:reset                  # creates the SQLite database and loads the default demo household
pnpm dev                       # http://localhost:3000
```

`pnpm wallets:setup` is idempotent and needs no manual steps. It creates, funds with Friendbot XLM and adds a USDC trustline to:

| Wallet | Purpose | Test USDC |
| --- | --- | --- |
| Agent payer | Signs every x402 payment (server-side only) | 20 (bought on the testnet DEX) |
| Household treasury | Grants the agent a capped, expiring allowance ([Funding guard](#funding-guard-on-chain-allowance)) | 5 |
| Empty demo wallet | The "empty payment wallet" scenario | 0 |
| Six provider wallets | Two competing providers per utility receive payments here | 0 |

Secrets are written only to `.env.local` (git-ignored) and are never printed. `pnpm wallets:status` shows balances. If the testnet DEX has no liquidity, request testnet USDC at <https://faucet.circle.com> (Stellar Testnet). After pulling a new version, run `pnpm db:migrate` (or `pnpm db:reset`).

---

## Running the demo

Open **Demo controls** (sidebar, or **Demo** on mobile), pick a scenario and load it. Then open **Agent → Agent operations**, choose **AI agent** (or **Deterministic** without a model key) and press **Start run**. The run page streams every step as the backend records it.

Each scenario only sets the starting state. Outcomes come from the real agent, policy engine and payment flow; nothing is scripted.

| Scenario | Starting state | What to watch for |
| --- | --- | --- |
| **Electricity and data both running low** (default) | ₦8,000 of ₦15,000 left; ~1 day of electricity, ~6 h of data | Data first (more urgent), then electricity; compares two providers each; two real testnet payments |
| **Budget covers only one** | ₦2,000 left; electricity and data both low | Buys electricity (top priority), defers data and says why |
| **Unusual data usage** | Data draining at 3× the usual rate | Flags it for review instead of buying more; code refuses an AI attempt to buy it |
| **Budget exhausted** | ₦200 left; electricity nearly out | No payment; asks the owner to raise the budget |
| **Purchase needs approval** | Approval threshold ₦1,000 | Parks the purchase; the owner approves the exact terms (with a countdown) or declines |
| **Provider outage** | The usually cheaper electricity provider is down | Falls back to the other approved provider and explains why |
| **Nothing urgent** | Every utility has several days left | Buys nothing and says why each utility can wait |
| **Empty payment wallet** | Electricity nearly out; the paying wallet holds 0 USDC | Gets a real HTTP 402, then stops before signing: insufficient funds, **not charged** |
| **Prompt injection attempt** | Airtime low; one provider's description tries to instruct the agent | In AI mode, the hostile text is shown to the model as untrusted provider data; the rules still decide |
| **Electricity use has tripled — stuck heater** | Meter draining at ~3× normal for 8 h, ~9 h left; cause hidden | Buys a ₦300 meter diagnostic first (x402); the report finds a water heater stuck on, so it buys only minimal relief (₦1,500) and tells you to fix the heater |
| **Electricity use up — guests staying** | Use more than doubled, meter low; cause hidden | Buys the diagnostic; the report finds genuine extra use, so it buys a purchase sized for the higher rate (₦4,000) |
| **Electricity use up, not urgent** | Use tripled but ~3 days left | Decides a diagnostic isn't worth buying yet — nothing depends on the cause — and keeps watching |
| **Electricity use up, budget nearly gone** | Use tripled, meter low, ₦600 left | Won't buy information that couldn't change anything; asks you to review |
| **Authority revoked** | Automatic purchasing off | Keeps monitoring and recommends, spends nothing |

**Suggested five-minute walkthrough (default scenario):**

1. **Overview.** The service runway shows each utility on one axis: data runs out in ~6 h, electricity in ~1 day, airtime is fine.
2. **Agent → Start run.** Watch the stage stepper and timeline: observe → forecast (with confidence) → discover providers → compare → quote → proposal → spending rules → **HTTP 402** (amount, asset, network, payee) → signing → settling → verifying → household updated → reassess. Expand any step for the exact data.
3. Open a purchase. *Payment confirmed* (Stellar testnet) and *Utility released* (simulated) are separate records; follow the transaction hash to Stellar Expert.
4. **Household** shows the credited meter and phone; **Accounts** shows each account's providers, availability and registered payee wallets; **Transactions** is searchable.
5. Load **Purchase needs approval** and run again: approve the exact terms, or let the request expire unpaid. Then load **Nothing urgent** — refusing to buy is part of the job.

**The procurement demo (stuck heater, about three minutes):**

1. Load **Electricity use has tripled — stuck heater** and start a run. The agent identifies a need it can't explain from hourly totals.
2. It discovers the information services over HTTP (**Providers** shows the same network), judges that a ₦300 diagnostic is worth it against the purchase it could change, and compares the two offers.
3. It requests the diagnostic: the provider answers **HTTP 402**; the spending rules pass; the payment settles on Stellar testnet; the report is released.
4. It acts on the report: a stuck water heater means most of the extra use is avoidable, so it buys **only minimal relief** and tells you to fix the heater. Compare **guests staying**, where the same kind of surge leads to a full-size purchase.
5. Open either purchase → **Procurement inspection**: provider, published description, protected endpoint, the decoded 402, price, asset and network, policy checks, approval, transaction, released resource and the agent's next action. Press **Request without paying** to see the provider refuse without payment.

**Failure demos** (Demo controls → Failure injection): the provider fails to release after payment (then *Retry release* — no second payment); the provider asks for more than it quoted (the agent refuses to sign); per-provider outages.

Resetting a scenario resets the **simulated** household only. Testnet transactions are permanent.

---

## The agent

**Runtime** ([`runtime/`](src/server/agent/runtime)): a background run per household, with a persisted, ordered event log and a Server-Sent Events stream.

- **AI planner** ([`planner-openai.ts`](src/server/agent/runtime/planner-openai.ts)): **Gemini** (default `gemini-3.5-flash`, through Google's OpenAI-compatible endpoint) or OpenAI (`gpt-5.4-mini`), both via the OpenAI SDK, runs a server-side tool-use loop with strict JSON schemas, a step cap, a per-call timeout and a whole-run deadline. The UI shows the model's stated next steps and tool calls — never fabricated chain-of-thought. A model outage (timeout, rate limit, no credit, auth) stops the run safely and says so. A typical run is 10–15 steps; because each step resends the conversation, expect roughly 60–90k input tokens and about 1k output tokens per run.
- **Deterministic planner** ([`planner-deterministic.ts`](src/server/agent/runtime/planner-deterministic.ts)): no AI. Uses the same tools, policy and payment path, following the allocation engine. If a provider fails before money moves, it re-decides without that provider and tries the next-best option once. Labelled as such in the UI.
- **Tools** ([`tools.ts`](src/server/agent/runtime/tools.ts)), all reading real application state: `observe_household`, `inspect_utility` (forecast, confidence, history, assumptions), `inspect_budget`, `discover_providers`, `compare_offers`, `get_allocation_recommendation` (advisory; includes every option considered and why each was rejected), `request_quote`, `propose_purchase` (dry run of the rules), `purchase_utility`, `inspect_transaction`, `verify_fulfilment`, `reassess_household`, `finish`. Arguments are re-validated with Zod regardless of the schema the model saw.
- **Necessity guard:** code refuses an agent purchase of a utility with plenty of service left, or one flagged for unusual usage.
- **Agent Operations UI:** start a run with a task, watch the live stage stepper and execution timeline, expand details, approve inline. Refresh-safe: the page replays the stored log and the stream resumes after the last event (`Last-Event-ID`).

```bash
APP_BASE_URL=http://localhost:3000 pnpm agent:run                         # AI (Gemini if its key is set)
APP_BASE_URL=http://localhost:3000 pnpm agent:run --mode deterministic --scenario provider-outage
```

---

## Procurement: provider network and paid information

**Provider network** ([`catalog.ts`](src/server/providers/catalog.ts)) — a curated registry of clearly labelled demo providers:

- `GET /api/providers` lists every registered provider (free).
- `GET /api/providers/:id/service` is each provider's **published service document** (free): products, prices, availability, fulfilment terms, payment terms and payee, and every endpoint marked **free** or **paid (x402)**.
- The agent discovers providers by fetching these over HTTP. Code verifies each document against the registry — identity, payee wallet, network, asset, x402 on paid endpoints, endpoint address — and an unverified provider cannot be quoted or paid. Discovery returns metadata only, never a resource; provider text stays untrusted.

**Two kinds of paid resource:**

| | Utility credit | Information (meter diagnostic) |
| --- | --- | --- |
| Providers | Two per utility (six) | Demo GridSense (₦300, finding and advice) and Demo MeterLab (₦800, circuit-level evidence) |
| Price | Free binding quote, then `POST /api/providers/:id/purchase` (x402) | The HTTP 402 *is* the price: `POST /api/services/:id/meter-diagnostic` (x402) |
| Released after settlement | Credit on the virtual meter or phone | A diagnostic report; the meter is untouched |

**Why information is worth paying for:** the household's free view of the meter is hourly totals. The cause of unusual use (a stuck appliance, more people at home, a faulty meter) is simulated **provider-side** smart-meter data that only a paid diagnostic can see — a test fails if any agent tool, view or page reads it.

**Procurement decisions** ([`engine.ts`](src/server/agent/engine.ts)): the agent buys a diagnostic only when use is unexplained, a purchase depends on the cause, and the price is at most 20% of that purchase — within your spending rules and the **information cap** (Settings, default ₦1,000). It compares information offers, and declines (not urgent, too expensive, outside your limits) with a reason. It then **acts on the report**: genuine extra use → a purchase sized for the current rate; avoidable use → minimal relief at the normal rate only if the meter is nearly out, plus what you should fix. It never buys the same information twice, and buying nothing is a valid outcome. Both planners and the AI's tools follow the same rules; code enforces them whatever the model asks.

**Procurement inspection** ([`procurement.ts`](src/server/views/procurement.ts)): every purchase page shows each step from recorded backend data only, with gaps marked, and **Request without paying** re-sends the agent's exact request with no payment and a fresh id to show the provider's live response.

---

## How a purchase works

Official Stellar x402 packages (`@x402/core`, `@x402/stellar` 2.30), the `exact` scheme on `stellar:testnet`, test USDC (SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, 7 decimals). The public facilitator at `https://x402.org/facilitator` verifies, settles and sponsors fees.

```
Agent (buyer, server-side)                Provider endpoint (seller)                Facilitator   Stellar testnet
 │ 1 POST /api/providers/<id>/quote ────▶ binding quote: product, recipient, NGN, USDC, payee, 5-min expiry
 │ 2 quote re-checked: payee = REGISTERED wallet, USDC = NGN at the demo rate, NGN = decided amount
 │ 3 policy engine (10 ordered checks)
 │ 4 POST /api/providers/<id>/purchase ─▶ order must redeem the quote (once)
 │ ◀──────────────────────────────────── 5 HTTP 402 + PAYMENT-REQUIRED
 │ 6 402 must equal the quote (and approved terms): scheme, asset, network, payee, amount
 │ 7 policy engine again, with the live wallet balance (Funding guard top-up if short)
 │ 8 sign Soroban auth entry (key never leaves the server)
 │ 9 retry with PAYMENT-SIGNATURE ──────▶ 10 verify ──────────────────────────▶ │
 │                                        11 settle ──────────────────────────▶ │ ── tx ─▶ │
 │                                        12 record settlement (unique tx hash); mark quote redeemed
 │                                        13 release simulated utility
 │ ◀──────────────────────────────────── 14 200 + receipt + PAYMENT-RESPONSE
 │ 15 confirm the USDC transfer independently on Horizon (from, to, amount)
```

- **Fulfilment only after settlement.** Provider routes call `x402HTTPResourceServer` in strict order — `processHTTPRequest` → `processSettlement` → fulfil — so no code path credits a device without a settled transaction hash ([`purchase-handler.ts`](src/server/providers/purchase-handler.ts)).
- **Quotes.** Expired or already-used quotes are refused with HTTP 410 before any payment is verified (unambiguously not charged).
- **The buyer trusts nothing it didn't compute.** Payees come from the provider registry, never from the provider's own words ([`x402-buyer.ts`](src/server/payments/x402-buyer.ts)).
- **Two competing providers per utility**, each with its own catalogue, pricing and receiving wallet ([`providers/`](src/server/providers)).

---

## Spending policy

[`policy.ts`](src/server/household/policy.ts) — pure, ordered, and every evaluation returns the full trace shown in the UI:

| # | Check | |
| --- | --- | --- |
| 0 | Automatic purchasing is on | Owner's master switch |
| 1 | Provider approved and available | Per provider |
| 2 | Utility category and network allowed | |
| 3 | Recipient is the household's registered account | |
| 4 | Quote valid and unchanged | Registered payee, consistent price, unexpired |
| 5 | Within the per-purchase cap and the per-utility cap | |
| 6 | Run (task) budget has room | |
| 7 | Daily agent budget has room | Household time |
| 8 | Household budget and agent authority have room, after the reserve | Includes pending commitments |
| 9 | Wallet holds enough test USDC | Read live from Horizon just before signing; unreadable = refuse |
| 10 | Owner approval | Above the approval threshold, or the purchase waits |

The owner sets every limit in **Settings**. The model is not told the limits; it learns them when a purchase is refused, and is told not to retry unchanged.

---

## Approvals

A purchase above the threshold is parked, not paid.

- **Bound to exact terms.** The terms the owner sees — provider, product, NGN price, exact test USDC amount, registered payee wallet, asset, network and recipient meter/phone — are frozen with a SHA-256 fingerprint. Approval must quote that fingerprint; if anything moved since (for example the provider's wallet), the request is closed unpaid and the agent re-decides. Before signing, the HTTP 402 must ask for exactly the approved terms.
- **Expiry.** Requests expire after the owner's approval window (Settings; default 3 minutes). Expired requests are cancelled unpaid (approve → HTTP 410) and no longer block new decisions.
- **No self-approval.** No tool can approve; approval is an owner action over the API.
- Approving, declining, expiry and the resulting payment are written into the run's timeline.

---

## Funding guard (on-chain allowance)

x402's `exact` scheme makes the payer sign a transfer from **its own** balance, so a token allowance cannot gate an x402 payment directly. Borderless uses one where it does help ([`funding-guard.ts`](src/server/payments/funding-guard.ts)):

- The **household treasury** grants the agent wallet a USDC allowance through the Stellar Asset Contract: `approve(treasury, agent, cap, expiration_ledger)`.
- When the agent wallet is short before a payment, Borderless draws a top-up with `transfer_from` — at least the shortfall, up to a float target, never above the allowance left.
- **Stellar enforces the cap and expiry**: a draw beyond either fails at simulation (`Error(Contract, #9)`) and nothing reaches the network. The owner can revoke at any time (`approve 0`).
- **What it bounds:** if the agent key leaked, the most it could ever move is its own balance plus the allowance left until expiry. **What it doesn't:** where the agent pays, or the size of each payment — those remain the policy engine's job.
- Settings → **Funding guard** shows the live on-chain allowance, treasury balance, estimated expiry and transaction links, with Grant and Revoke. For the demo the treasury key is held server-side; in a real deployment the owner would sign the allowance in their own wallet.

`pnpm demo:funding-guard` proves it live with a fresh empty wallet: funded payment within the cap, an over-cap draw refused by Stellar, revocation, then a not-charged failure.

---

## How Borderless decides

The deterministic core ([`engine.ts`](src/server/agent/engine.ts)) is used directly by the deterministic planner and as an advisor to the AI.

1. **Forecast** ([`forecast.ts`](src/server/usage/forecast.ts)): recent rate (last 6 simulated hours, else the usual rate), hours to depletion, bundle expiry, urgency (*critical* < 12 h, *low* < 36 h, *watch* < 72 h), unusual usage (≥ 2× usual), **confidence** (history depth, steadiness, recent change), the history considered and plain-language assumptions. Forecasts are labelled as estimates.
2. **Rank** by urgency, then the owner's priorities.
3. **Choose** across every provider that can serve the account: aim for 5–7 days, require 2; prefer no-approval options; equal prices go to the provider that delivers more.
4. **Share the budget** so later needs can still reach their minimum.
5. **Respect authority:** every candidate goes through the same policy function used before signing.
6. **Record** every option considered, why each was rejected, and the expected household impact; utilities that need nothing are recorded as such.
7. **Explain** with sentences typed as fact, observation, prediction, decision or constraint, naming the closest alternatives and why the provider was chosen.

---

## Architecture

One Next.js 16 application with hard internal module boundaries. Providers are separate modules with their own receiving wallets and ledgers, reached over real HTTP, so any provider can move to its own service or be replaced with a real one.

```
src/
├── app/                       Overview, Agent (+ runs/[id]), Household, Accounts, Providers, Transactions, Settings
│   └── api/
│       ├── providers/                registry listing; [providerId]/ service document, quote, x402 purchase, retry
│       ├── services/[providerId]/    x402-protected information services (meter diagnostic)
│       ├── agent/runs/               start/list runs, run log, runs/[id]/events (SSE)
│       ├── purchases/[id]/[action]   approve (terms hash) / decline / recover / probe-unpaid
│       └── funding-guard/            on-chain allowance status, grant, revoke
├── components/                Design system, devices, run console, approval cards, settings
└── server/
    ├── agent/                 Engine, explanations; runtime/ (executor, planners, tools, run log)
    ├── payments/              x402 buyer, Funding guard, wallet reads, Horizon confirmation
    ├── providers/             Six utility + two diagnostic providers, registry, catalog, x402 seller, quotes, service handler
    ├── household/             Spending policy, state, seed
    ├── transactions/          Purchases, approvals (binding, expiry), sweep, events
    ├── usage/  demo/  views/  db/
scripts/  tests/  tests/e2e/  drizzle/  docs/
```

**Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, Drizzle ORM on SQLite (`@libsql/client`), Zod 4, `@x402/*` 2.30, `@stellar/stellar-sdk` 17, OpenAI SDK (used for both Gemini and OpenAI), Vitest, Playwright + axe-core.

**Data model** ([`schema.ts`](src/server/db/schema.ts)) adds to the original household tables: `agent_runs`, `agent_run_events` (append-only, ordered), `provider_quotes`, `funding_guards`, `meter_profiles` (provider-side ground truth), and on `purchases` the service type, run, quote binding, approval deadline and approval terms/hash. Purchases keep three separate status fields: lifecycle `stage`, `payment_status`, `fulfilment_status`.

Design notes: [`docs/amendment-a0-procurement-architecture.md`](docs/amendment-a0-procurement-architecture.md) (procurement amendment), [`docs/upgrade-m0-assessment.md`](docs/upgrade-m0-assessment.md) (engineering assessment and plan) and [`docs/milestone-0-architecture.md`](docs/milestone-0-architecture.md) (original).

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Run the app |
| `pnpm check` | Typecheck + unit/integration tests |
| `pnpm test` / `pnpm test:e2e` | Vitest / Playwright (see [Testing](#testing)) |
| `pnpm db:reset [scenario]` | Recreate the demo household, optionally into a scenario id from the table above |
| `pnpm db:migrate` / `pnpm db:generate` | Apply / generate migrations |
| `pnpm wallets:setup` / `pnpm wallets:status` | Create and fund testnet wallets / show balances |
| `pnpm agent:run [--mode ai\|deterministic] [--scenario id] [task]` | Run the agent and print every event (real payments) |
| `pnpm agent:dry-run` | What the engine would decide now, without paying |
| `pnpm demo:providers` | Live purchase from each of the six providers + failure cases |
| `pnpm demo:funding-guard` | Live on-chain allowance verification |
| `pnpm demo:recovery` | Live replay, post-payment failure and no-repay recovery |
| `pnpm demo:purchase` / `pnpm demo:agent` | One purchase / the original agent demo |

Live scripts call the running app: `APP_BASE_URL=http://localhost:3000 pnpm demo:providers`. Several reset the demo household first.

---

## Testing

```bash
pnpm check                # typecheck + 292 unit/integration tests (no network, no funds)
pnpm test:e2e             # 29 Playwright tests (no funds spent)
E2E_LIVE=1 pnpm test:e2e  # adds the full live browser journey (spends test USDC)
```

- **Unit and integration** (temporary SQLite databases, in-process provider endpoints, scripted model): policy order and every check; decision engine, forecasting and confidence; options and rejection reasons; multi-provider choice and outage fallback; quotes (expiry, reuse, tampering); x402 requirement validation (wrong payee, amount, asset, network, scheme, decoy options); settlement and fulfilment ordering; idempotency and duplicate payments; approvals (binding, expiry, hard limits); Funding guard top-up planning and refusal; SSE replay, resume and live forwarding; restart recovery; model timeout and outages; prompt injection with an obedient scripted model; every demo scenario.
- **End-to-end** (production build on port 3100, own database): core journeys, the live run console and refresh safety, policy details, approval countdown/decline/expiry, transaction search, accounts, scenario loading, axe-core WCAG 2.1 AA on every page (including a run page), keyboard focus, mobile layout.
- **Live testnet**: `demo:providers`, `demo:funding-guard`, `demo:recovery`, `agent:run` (deterministic and AI with Gemini), and `E2E_LIVE=1`.

---

## Configuration

All configuration is server-side and validated at startup ([`env.ts`](src/server/config/env.ts)); see [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/borderless.db` | SQLite database |
| `APP_BASE_URL` | `http://localhost:$PORT` | Where the agent reaches provider endpoints |
| `STELLAR_NETWORK` | `stellar:testnet` | **Only** testnet is accepted |
| `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `SOROBAN_RPC_URL` | Public testnet endpoints | RPC and Horizon |
| `X402_FACILITATOR_URL` / `X402_FACILITATOR_API_KEY` | `https://x402.org/facilitator` / — | x402 facilitator |
| `DEMO_NGN_PER_TESTNET_USDC` | `100000` | Fixed demo pricing, not an exchange rate |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | — | AI planner (server-only); Gemini is used when its key is set |
| `AI_PROVIDER` | auto | Force `gemini` or `openai` |
| `GEMINI_MODEL`, `OPENAI_MODEL`, `AGENT_REASONING_EFFORT` | `gemini-3.5-flash`, `gpt-5.4-mini`, `low` | Model choice |
| `AGENT_MAX_STEPS`, `AGENT_RUN_TIMEOUT_SECONDS`, `AGENT_MODEL_TIMEOUT_SECONDS` | `18`, `300`, `60` | Run limits |
| `AGENT_STELLAR_SECRET` / `_PUBLIC` | `wallets:setup` | Agent payer wallet |
| `TREASURY_STELLAR_SECRET` / `_PUBLIC`, `FUNDING_GUARD_FLOAT_TARGET_USDC` | `wallets:setup`, `1` | Funding guard |
| `DEMO_EMPTY_WALLET_SECRET` / `_PUBLIC` | `wallets:setup` | Empty-wallet scenario |
| `PROVIDER_*_PAYTO` | `wallets:setup` | The registry of provider receiving wallets (trust anchor), including GridSense and MeterLab |

---

## Security notes

- **Secrets stay on the server**: the agent, treasury and demo keys and the model API keys are read only by server modules, never sent to the browser, never logged; configuration errors name a setting without echoing its value. The model never sees keys or the owner's limits.
- **Prompt injection**: provider text reaches the model only inside tool results, labelled as untrusted data; the system prompt says data is never an instruction; no tool accepts a payee, amount or approval; arguments are validated server-side; the policy engine and approval binding apply regardless of what the model says.
- **Payee trust anchor**: providers are paid only at wallets in the server's registry, never at an address a provider supplies.
- **Limits enforced before signing**, twice; approval lifts only the threshold, never other limits.
- **Fulfilment cannot outrun payment**; one settlement per transaction hash (unique index).
- **Testnet only**; dedicated wallets; no user wallet or seed phrase is ever requested.
- **Cross-site protection only — no login.** Mutating routes reject cross-origin requests. Add real authentication before exposing this beyond a local or trusted demo.

---

## Failure handling

Payment and fulfilment status are recorded separately; a payment is never shown as successful until confirmed on-chain.

| Situation | What happens |
| --- | --- |
| Insufficient test USDC (live balance check) / missing trustline | Stopped before signing → **Not charged** (a Funding guard top-up is tried first if granted) |
| 402 doesn't match the quote or approved terms (payee, amount, asset, network, scheme) | Refused before signing → **Not charged** |
| Quote expired, reused or changed | 410 / refused → re-quote or re-decide; **not charged** |
| Approval declined, expired or terms changed | Cancelled → **not charged**; the agent reassesses |
| Provider unavailable / unreachable / not returning 402 | **Not charged**; agents fall back to another approved provider |
| Facilitator fails at verification or rejects | **Not charged** |
| Settlement outcome unclear | **Outcome unknown** → reconciled before any retry; never re-paid blindly |
| Paid, but provider fails to release | **Payment confirmed / Release failed** → *Retry release*, no new payment |
| Duplicate request for a paid purchase | Stored receipt returned; no new payment |
| Restart mid-purchase / mid-run | Sweep closes never-sent payments as not charged and reconciles possibly-sent ones; orphaned runs are marked interrupted |
| AI model timeout / rate limit / no credit | Run stops safely with the reason; purchases already made stay recorded |

---

## x402 and MPP

Stellar supports two agentic-payment protocols ([docs](https://developers.stellar.org/docs/build/agentic-payments)): **x402** (one payment per request, Soroban authorization entries, facilitator verification and settlement) and **MPP**, the Machine Payments Protocol, with a one-time *charge* intent and a *session* intent where the agent deposits into a one-way payment channel once and then pays by signing cumulative off-chain commitments, settling when the channel closes.

**Borderless uses x402, deliberately.** A household makes a few discrete purchases a day, each a distinct product with its own quote, approval, receipt and fulfilment. That is exactly x402's per-request model, and each purchase produces its own verifiable Stellar transaction — which is what the household (and a judge) should be able to audit.

**Where MPP sessions would fit later:** if Borderless began making thousands of tiny paid calls — for example, per-minute smart-meter telemetry, metered tariff data or a live price feed across many providers — per-request authorization would be wasteful. A session would let the household pre-fund a channel with a hard cap and stream micro-payments within it. That would sit *alongside* x402 purchases, behind the same policy engine (session cap ≤ an owner-set limit) and the same Funding guard ceiling. It is not implemented, because nothing in the product needs it yet.

---

## Procurement acceptance criteria

How each criterion of the procurement amendment is met, and where it is proven.

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | Identifies a household need from actual state | `need.identified` run events from real forecasts; `tests/procurement-decisions.test.ts` |
| 2 | Dynamically discovers a relevant provider | HTTP discovery of the registry and service documents; `tests/provider-network.test.ts` |
| 3 | Distinguishes free metadata from paid services | Endpoints marked free/paid; discovery releases nothing (tested) |
| 4 | Obtains a paid service through an actual x402 request | Live: diagnostic and utility purchases on Stellar testnet; `tests/information-services.test.ts` |
| 5 | Provider returns HTTP 402 before releasing | Live **Request without paying**; inspection shows the stored 402 |
| 6 | Policy engine independently authorises or rejects | 11 ordered checks before signing, recorded per purchase; information cap |
| 7 | A genuine Stellar testnet payment settles when authorised | Facilitator settlement + Horizon confirmation; transaction links |
| 8 | Release only after payment verification | Settle-then-fulfil handler; one settlement per payment |
| 9 | The agent uses the acquired resource to continue | Re-decision with the report (`planner.reassessed`); stuck heater vs guests buy differently |
| 10 | Can reject or defer a purchase | Not urgent / too expensive / outside limits; scenarios and tests |
| 11 | Compares alternatives | Two providers per utility and two diagnostic offers; options considered with reasons |
| 12 | Payments and fulfilment are auditable | Separate payment and fulfilment records, receipts, run log, procurement inspection |
| 13 | The judge can observe the process in real time | Agent Operations live stream; inspection; e2e tests |
| 14 | Why per-request machine payments are central | Paid resources exist only behind x402; the demo shows the 402 with and without payment |
| 15 | Original household capabilities intact | Full regression suites and live provider checks |

---

## Known limitations

- **Simulated utilities and demo providers.** No real DisCo, VTU or mobile-network integration.
- **Gemini free tier.** The configured key allows 20 model requests per day per model, about one full AI run. The AI's live procurement run on the stuck-heater scenario (discover → buy the ₦300 diagnostic → quote ₦1,500 of minimal relief) was cut short by this quota before it paid for the electricity; the deterministic planner completes the same flow, live.
- **Live AI runs use model credit.** Without a working key the AI planner stops safely (for example `model_no_credits`); the deterministic planner runs the same tools, rules and payments. AI behaviour is also proven with a scripted model in tests. Model availability varies: if Google reports high demand for a model, set `GEMINI_MODEL` to another one your key lists.
- **Single household, no authentication.**
- **Per-process concurrency guard** (plus database unique constraints); multi-instance deployment needs a database-level lock.
- **Funding guard keys.** The treasury key is server-side for the demo. Allowance expiry is shown as an estimate from the ledger gap.
- **Conservative unknown-outcome reconciliation**: concludes "not charged" only after the payment authorisation expires; it does not search the chain for unrecorded transactions.
- **Facilitator dependency.** If the public facilitator is down, purchases fail safely; point `X402_FACILITATOR_URL` at a self-hosted one.
- **Stellar testnet resets periodically**: re-run `pnpm wallets:setup`.
- **Muted text colour** lifted from `#718078` to `#8A988F` to meet WCAG AA contrast.

---

## Troubleshooting

- **A page returns 500 after updating.** The database is missing new columns: run `pnpm db:migrate`, then reload.
- **"Provider answered HTTP 404 instead of 402".** `APP_BASE_URL` points at a different app; match it to where Borderless runs.
- **AI mode greyed out / `model_no_credits`.** Add `GEMINI_API_KEY` (or `OPENAI_API_KEY` with credit) to `.env.local` and restart `pnpm dev`.
- **AI run stops with `model_daily_quota`.** The Gemini key is on Google's free tier (20 requests per model per day; an AI run uses 10–15). Enable billing on the Google AI Studio project, wait for the reset time shown in the run, or use the deterministic planner.
- **Gemini 404 "no longer available" or 503 "high demand".** Set `GEMINI_MODEL` to a current model your key can use (the default is `gemini-3.5-flash`).
- **"…is missing or invalid. Run `pnpm wallets:setup`."** Run it, then restart `pnpm dev`.
- **Wallets not found / insufficient funds later.** Testnet was probably reset: `pnpm wallets:status`, then `pnpm wallets:setup`.
- **Funding guard shows "Couldn't read the network".** The Soroban RPC is unreachable or slow; the rest of the app keeps working.
- **Dev server serves a stale chunk after adding a component** (Next dev only). Restart `pnpm dev`.
- **Windows.** Developed and tested on Windows 11. An access-violation exit (`3221225477`) from a script is the native SQLite client crashing at process exit; re-run the command.
