# Borderless

**An autonomous household utilities agent.** Borderless watches a household's electricity, airtime and mobile data, predicts shortages, decides what to buy within limits the owner sets, pays for it through **x402 on Stellar testnet**, and records a verifiable receipt when the provider releases the utility.

> **Testnet and simulation.** Every payment is a real transaction on **Stellar testnet** using testnet USDC, which has **no monetary value**. Electricity, airtime and data are **simulated**: the meter and phones are virtual devices, the providers are demo services, and demo electricity tokens are not valid on any physical meter.

```
A household has a need → Borderless identifies it → Borderless decides → Borderless pays (x402)
→ the provider verifies and settles on Stellar testnet → the simulated utility is released
→ the virtual device updates → an auditable receipt is recorded
```

---

## Contents

- [Quick start](#quick-start)
- [Running the demo](#running-the-demo)
- [How a purchase works](#how-a-purchase-works)
- [How Borderless decides](#how-borderless-decides)
- [Architecture](#architecture)
- [Commands](#commands)
- [Testing](#testing)
- [Configuration](#configuration)
- [Security notes](#security-notes)
- [Failure handling](#failure-handling)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

---

## Quick start

**Prerequisites:** Node.js 22.23.4 or later (developed on Node 24), pnpm 10, and internet access to Stellar testnet.

```bash
pnpm install
cp .env.example .env.local
pnpm wallets:setup      # creates and funds 4 testnet wallets, writes keys to .env.local
pnpm db:reset           # creates the SQLite database and loads the default demo household
pnpm dev                # http://localhost:3000 (or the next free port)
```

`pnpm wallets:setup` is idempotent and needs no manual steps:

1. Generates an **agent payer** wallet and three **provider** wallets (electricity, airtime, data).
2. Funds each with testnet XLM from Friendbot.
3. Adds a testnet USDC trustline to each.
4. Buys 20 testnet USDC for the agent on the Stellar **testnet** DEX (about 600 demo purchases).

Secrets are written only to `.env.local`, which git ignores, and are never printed. Run `pnpm wallets:status` at any time to check balances. If the testnet DEX has no liquidity, request testnet USDC for the agent's address at <https://faucet.circle.com> (Stellar Testnet) instead.

---

## Running the demo

Open **Demo controls** at the bottom of the sidebar (the **Demo** button on mobile). Pick a scenario, load it, then press **Assess household now**.

Each scenario only sets the starting state. The outcome comes from Borderless's real decision engine, budget rules and payment flow; nothing is scripted.

| Scenario | Starting state | What to watch for |
| --- | --- | --- |
| **Electricity and data both running low** (default) | ₦8,000 of ₦15,000 left; about a day of electricity, six hours of data | Ranks data first (more urgent), buys both within budget, explains why. Two real testnet payments. |
| **Budget covers only one** | ₦2,000 left; electricity and data both low | Buys electricity (top priority), defers data and says why. One payment. |
| **Unusual data usage** | Data draining at 3× the usual rate | Flags the change for review instead of buying more data. No payment. |
| **Budget exhausted** | ₦200 left; electricity nearly out | Makes no payment; asks the owner to raise the budget or change priorities. |
| **Purchase needs approval** | Approval threshold ₦1,000 | Holds the purchase until the owner clicks **Approve and pay** or **Decline**. |
| **Authority revoked** | Automatic purchasing off | Keeps monitoring and recommends a purchase, but spends nothing. |

**Suggested three-minute walkthrough (default scenario):**

1. **Overview.** The service runway shows every utility on one 7-day axis: data runs out in about 6 hours (coral), electricity in about a day (amber).
2. Press **Assess household now**. The activity feed fills in as each step is persisted: shortage, decision, *HTTP 402: 0.02 testnet USDC required*, payment authorised, settled, confirmed on Stellar, utility released.
3. **Agent.** Read the decision. Every line is tagged *Fact*, *Observed*, *Predicted*, *Decision* or *Held back*.
4. **Household.** The meter shows the credited kWh and a demo token; the phone shows the bundle activation message.
5. **Transactions → open a purchase.** *Payment confirmed* (Stellar testnet) and *Utility fulfilment confirmed* (simulated) are separate records. Follow the transaction hash to Stellar Expert.
6. **Demo controls → Advance time**, or set data to **3×** usage, to watch Borderless react to usage changing.

**Failure demos:** in Demo controls, turn on *Provider fails to release the utility after a successful payment*, then buy something. The payment confirms on-chain but the device isn't credited, and the purchase shows **Needs attention**. Turn the fault off and press **Retry release**: the utility is released once, with no second payment. Provider outages can be toggled the same way.

Resetting a scenario resets the **simulated** household only. Testnet transactions already on Stellar are permanent.

---

## How a purchase works

Borderless uses the official Stellar x402 packages (`@x402/core`, `@x402/stellar` 2.30), the `exact` scheme on `stellar:testnet`, and testnet USDC (SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`). The public facilitator at `https://x402.org/facilitator` verifies, settles and sponsors fees.

```
Agent (buyer, server-side)          Provider endpoint (seller)           Facilitator        Stellar testnet
 │ 1 spending-authority check
 │ 2 POST /api/providers/<kind>/purchase ─▶ validate order (meter, network, product)
 │ ◀──────────────────────────────────── 3 HTTP 402 + PAYMENT-REQUIRED
 │ 4 requirements must equal OUR quote: asset, network, payTo, amount
 │ 5 sign Soroban auth entry (key never leaves the server)
 │ 6 retry with PAYMENT-SIGNATURE ─────▶ 7 verify ─────────────────────▶ │
 │                                      8 settle ─────────────────────▶ │ ── submit tx ─▶ │
 │                                      9 record settlement (unique tx hash)
 │                                     10 release simulated utility
 │ ◀──────────────────────────────── 11 200 + receipt + PAYMENT-RESPONSE
 │ 12 confirm the USDC transfer independently on Horizon (from, to, amount)
 │ 13 store receipt; payment and fulfilment recorded separately
```

Key decisions:

- **Fulfilment only after settlement.** `@x402/next`'s `withX402` runs the route handler *before* settling, which would release utilities before payment. Provider routes therefore call the lower-level `x402HTTPResourceServer` in a strict order: `processHTTPRequest` (402 or verify) → `processSettlement` → fulfil. No code path credits a device without a settled transaction hash. See [`purchase-handler.ts`](src/server/providers/purchase-handler.ts).
- **The buyer trusts nothing it didn't compute.** It signs only requirements that match its own quote (asset, network, provider address, exact amount). The SDK's spend controls and a payment policy act as a second layer. See [`x402-buyer.ts`](src/server/payments/x402-buyer.ts).
- **Independent confirmation.** A payment is `confirmed` only after Horizon shows a successful transaction containing a USDC transfer from the agent wallet to the provider for the expected amount. See [`horizon.ts`](src/server/payments/horizon.ts).
- **Demo pricing.** Household budgets are in naira; payments are in testnet USDC. A fixed, labelled setting maps one to the other (default ₦100,000 = 1 testnet USDC, so ₦3,000 = 0.03). It is not an exchange rate.

---

## How Borderless decides

All purchasing rules are deterministic backend code. There is no LLM in the decision path, and none is required to run the product.

1. **Forecast** ([`forecast.ts`](src/server/usage/forecast.ts)): the recent consumption rate (last 6 simulated hours, falling back to the baseline), hours to depletion, data bundle expiry, and urgency: *critical* under 12 h, *low* under 36 h, *watch* under 72 h. Recent use at 2× the usual rate or more is flagged as unusual.
2. **Rank** ([`engine.ts`](src/server/agent/engine.ts)): urgency first, then the owner's priority order breaks ties. A critical need can outrank a higher-priority need that is only low.
3. **Choose a product:** aim for 5–7 days of service, require at least 2 days, prefer options that don't need approval. For a critical shortage, buy partial relief if that's all the limits allow.
4. **Share the budget:** before sizing a purchase, reserve the minimum the remaining needs require, so ₦4,000 can buy ₦3,000 of electricity *and* ₦500 of data rather than ₦4,000 of electricity alone.
5. **Respect authority:** every candidate is checked with the same `evaluateSpendingAuthority` function the payment layer enforces before signing (per-purchase limit, remaining budget including pending commitments, overall agent limit, approval threshold, approved services, networks and providers, automatic purchasing on or off).
6. **Explain** ([`explain.ts`](src/server/agent/explain.ts)): templated sentences typed as fact, observation, prediction, decision or constraint. Unusual usage is described as a change in the household's usage, never as a provider error.
7. **Persist, then act** ([`run.ts`](src/server/agent/run.ts)): the decision record (input snapshot, shortages, urgency, candidates, selection, reasoning, budget impact, outcome) is written *before* any purchase is created.

---

## Architecture

One Next.js 16 (App Router, TypeScript) application with hard internal module boundaries. Providers are separate modules with their own receiving wallets and their own ledgers, and the agent calls them over real HTTP, so any provider can be moved to its own service, or replaced with a real one, without changing the agent or payment code.

```
src/
├── app/                      Pages (Overview, Agent, Household, Transactions, Settings) and API routes
│   └── api/providers/[kind]/ x402-protected provider endpoints + fulfilment retry
├── components/               Design-system primitives, devices, runway, decision log, settings form
├── lib/                      Formatting and status vocabulary shared by server and client
└── server/                   Server-only
    ├── agent/                Decision engine, explanations, orchestrator
    ├── payments/             x402 buyer, demo pricing, Horizon confirmation
    ├── providers/            Provider modules (electricity, airtime, data), x402 seller, registry
    ├── household/            Spending-authority rules, state loading, seed
    ├── usage/                Forecasting and deterministic simulator
    ├── transactions/         Purchases, approvals, interrupted-purchase sweep, activity events
    ├── demo/                 Scenarios and fault injection
    ├── views/                Read models for the UI
    └── db/                   Drizzle schema, client, migrations
scripts/                      Wallet setup/status, DB reset, live demo and verification scripts
tests/                        Integration tests; tests/e2e/ Playwright
drizzle/                      SQL migrations
```

**Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4 (custom tokens), Lucide icons, Drizzle ORM on SQLite via `@libsql/client`, Zod 4, Vitest, Playwright with axe-core.

**Data model** ([`schema.ts`](src/server/db/schema.ts)): `households`, `household_members`, `household_budgets`, `agent_policies`, `utility_providers`, `utility_accounts`, `utility_balances`, `usage_records`, `agent_decisions`, `purchases`, `payments`, `provider_settlements` (provider-side ledger, unique transaction hash), `fulfilments`, `receipts`, `activity_events`, `demo_scenarios`, `demo_faults`. Purchases carry **three separate status fields**: lifecycle `stage`, `payment_status`, `fulfilment_status`. Types are portable (text ids, epoch-ms timestamps, integer naira, atomic amounts as text), so moving to PostgreSQL means swapping `sqlite-core` for `pg-core`.

The original discovery notes and payment plan are in [`docs/milestone-0-architecture.md`](docs/milestone-0-architecture.md).

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the app |
| `pnpm build` / `pnpm start` | Production build and server |
| `pnpm check` | Typecheck and unit/integration tests |
| `pnpm test` | Unit and integration tests (Vitest) |
| `pnpm test:e2e` | End-to-end tests (Playwright); see [Testing](#testing) |
| `pnpm db:reset [scenario]` | Recreate the demo household, optionally into a scenario (`both-low`, `budget-covers-one`, `unusual-data`, `budget-exhausted`, `needs-approval`, `authority-revoked`) |
| `pnpm db:migrate` | Apply migrations without resetting data |
| `pnpm db:generate` | Generate a migration after changing the schema |
| `pnpm wallets:setup` | Create, fund and prepare the testnet wallets (idempotent) |
| `pnpm wallets:status` | Show wallet balances and trustlines (public keys only) |
| `pnpm agent:dry-run` | Show what Borderless would decide now, without paying |
| `pnpm demo:purchase` | One real x402 purchase from the command line (needs the app running) |
| `pnpm demo:providers` | Live purchase from each provider plus throwaway-wallet failure cases |
| `pnpm demo:recovery` | Live replay, post-payment failure and no-repay recovery checks |
| `pnpm demo:agent` | Live agent run: decide and pay, then flag unusual usage |

The live `demo:*` scripts call the running app. If it isn't on port 3000, pass its address: `APP_BASE_URL=http://localhost:3001 pnpm demo:agent`. Note that `demo:providers` and `demo:agent` reset the demo household first.

---

## Testing

```bash
pnpm check                # typecheck + 131 unit/integration tests (no network, no funds)
pnpm test:e2e             # 18 Playwright tests (no funds spent)
E2E_LIVE=1 pnpm test:e2e  # adds the full live journey in a browser (~0.06 testnet USDC)
```

- **Unit and integration** (Vitest, temporary SQLite databases, mocked HTTP): spending-authority rules, the decision engine (all four examples in the brief plus edge cases, and a sweep of 61 budget levels proving it never plans a purchase the backend would refuse), every demo scenario, forecasting and the simulator, provider validation and fulfilment, idempotency and duplicate prevention, the buyer refusing mismatched payment requirements before signing, facilitator outage, interrupted purchases, approvals, settings and the API's cross-site guard.
- **End-to-end** (Playwright, run against a production build on port 3100 with its own database and build folder): core journeys, examples C and D, approvals, revoking authority, scenario loading, axe-core WCAG 2.1 AA checks on every page, keyboard focus, and mobile layout.
- **Live testnet** (`demo:*` scripts and `E2E_LIVE=1`): real purchases from all three providers, insufficient-funds and missing-trustline failures with throwaway wallets, provider failure after payment with recovery, and the full browser journey.

---

## Configuration

All configuration is server-side and validated at startup ([`env.ts`](src/server/config/env.ts)). See [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/borderless.db` | SQLite database |
| `APP_BASE_URL` | `http://localhost:$PORT` | Where the agent reaches the provider endpoints |
| `STELLAR_NETWORK` | `stellar:testnet` | **Only** testnet is accepted |
| `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL` | Public testnet endpoints | Soroban RPC and Horizon |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | x402 facilitator |
| `X402_FACILITATOR_API_KEY` | — | Only for facilitators that require one |
| `DEMO_NGN_PER_TESTNET_USDC` | `100000` | Fixed demo pricing, not an exchange rate |
| `AGENT_STELLAR_SECRET` / `_PUBLIC` | set by `wallets:setup` | Agent payer wallet (server-only) |
| `PROVIDER_*_PAYTO` | set by `wallets:setup` | Provider receiving addresses |

To use a different facilitator, change `X402_FACILITATOR_URL`. For example, run the official self-hosted facilitator from [`stellar/x402-stellar`](https://github.com/stellar/x402-stellar) (`examples/facilitator`) and point this at it.

---

## Security notes

- **Secrets stay on the server.** The agent's signing key is read only by the payments module ([`env.ts`](src/server/config/env.ts) `agentSecret()`), is never sent to the browser, and is never logged. The UI shows only public addresses.
- **No secrets in git.** `.env*` (except `.env.example`), databases, key files and build output are git-ignored. `wallets:setup` writes keys only to `.env.local`.
- **Dedicated testnet wallets.** Borderless never asks for a user's own wallet or seed phrase. The configuration rejects any network other than `stellar:testnet`.
- **Limits enforced before signing.** Spending authority is checked when a purchase is created and again immediately before signing. Owner approval lifts only the approval threshold, never the budget or other limits.
- **No arbitrary destinations or amounts.** The buyer signs only for the provider address in its own configuration, the testnet USDC contract, and the amount from its own price table. The SDK's per-payment cap is set from the owner's per-purchase limit as a second layer.
- **Fulfilment cannot outrun payment.** Utilities are released only after facilitator settlement, and a transaction hash can be fulfilled once (unique index plus an in-process lock per purchase).
- **Cross-site protection.** The app has no login (single demo household). Mutating API routes reject requests whose `Origin` doesn't match the host, so another website can't drive the agent from a visitor's browser. **Add real authentication before exposing this beyond a local or trusted demo.**
- **Input validation.** Every API body is validated with Zod; provider orders are validated before any 402 is issued.

---

## Failure handling

Payment status and fulfilment status are always recorded separately. A payment is never shown as successful until it has been confirmed on-chain.

| Situation | What happens |
| --- | --- |
| Insufficient testnet USDC / missing trustline | Caught during simulation, before submission → **Not charged** |
| Requirements don't match our quote | Refused before signing → **Not charged** |
| Provider unreachable or not returning 402 | **Not charged** |
| Facilitator fails at verification | Provider reports it explicitly → **Not charged** |
| Facilitator rejects or the payment expires | Rejected via HTTP 402 → **Not charged** |
| Settlement outcome unclear (timeout after submitting) | **Outcome unknown** → reconciled before any retry; never re-paid blindly |
| Paid, but provider fails to release | **Payment confirmed / Release failed** → *Retry release* with no new payment |
| Duplicate request for a paid purchase | Stored receipt returned; no new 402, no new payment |
| Server restarted mid-purchase | Sweep: never-sent payments are closed as not charged; possibly-sent ones go to reconciliation |
| On-chain transfer doesn't match the receipt | Flagged as a mismatch; not shown as confirmed |

---

## Known limitations

- **Simulated utilities and demo providers.** No real DisCo, VTU or mobile-network integration. Tariffs, bundles and tokens are demo values.
- **Single household, no authentication.** Fine for a local or judged demo; real auth is needed before public deployment.
- **Concurrency guard is per process.** Duplicate-settlement protection uses an in-process lock plus database unique constraints. A multi-instance deployment would need a database-level lock (for example, a `settling` row claimed before settlement).
- **Unknown-outcome reconciliation is conservative.** If a payment's outcome is unknown and the provider has no settlement record, Borderless concludes "not charged" only after the 5-minute payment authorisation has expired. It does not search the chain for an unrecorded transaction.
- **Facilitator dependency.** The default is the public x402.org facilitator. If it is down, purchases fail safely (not charged); point `X402_FACILITATOR_URL` at a self-hosted facilitator for more control.
- **Stellar testnet resets periodically.** Wallets then disappear; run `pnpm wallets:setup` again (it re-creates accounts and trustlines, reusing your keys).
- **Soft 404.** An unknown transaction ID shows the not-found page, but returns HTTP 200 because the loading skeleton streams first.
- **Muted text colour.** The brief's `#718078` measured about 3.9:1 contrast on the app's surfaces, below WCAG AA (4.5:1), so it was lifted to `#8A988F` in the same hue.
- **No LLM.** Explanations are deterministic templates. An LLM could rephrase them later, but must never be allowed to change limits, decisions or payment states.

---

## Troubleshooting

- **Purchases fail with "Provider answered HTTP 404 instead of 402".** The agent is calling a different app. `APP_BASE_URL` defaults to the server's own port; if you set it manually, make sure it matches where Borderless is running.
- **"AGENT_STELLAR_SECRET is missing".** Run `pnpm wallets:setup`, then restart `pnpm dev`.
- **Wallets not found / insufficient funds after a while.** Stellar testnet was probably reset. Run `pnpm wallets:status`, then `pnpm wallets:setup`.
- **The dev server misbehaves after running a production build.** `pnpm test:e2e` builds into `.next-e2e/` and doesn't affect it, but a plain `pnpm build` shares `.next/`. Restart `pnpm dev` (delete `.next/` if needed).
- **Windows.** Developed and tested on Windows 11. If a script exits with an access-violation code (`3221225477`), it is the native SQLite client crashing at process exit with a connection open; `db:reset` closes its client explicitly for this reason. Re-run the command.
