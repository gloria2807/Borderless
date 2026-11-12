# Borderless — Milestone 0: Discovery, Architecture & Payment Plan

_Date: 2026-11-12. Status: proposed, awaiting founder sign-off on the items in §7._

## 1. Workspace findings

| Item | Finding |
| --- | --- |
| Project files | None. Only `claude/settings.local.json` (`{"attribution": false}`). Note: the folder is `claude/`, not `.claude/`, so Claude Code does not read it. |
| Git | Not a repository yet. Global git identity is already set; it will not be changed. |
| Toolchain | Node 24.22, npm 11.19, pnpm 10.32 (Windows 11). Official repo requires Node ≥ 22.23.4 — satisfied. |
| Network | Stellar testnet Horizon, Soroban RPC (`healthy`) and Friendbot all reachable. |

## 2. Official Stellar x402 tooling (verified, not assumed)

Source: `github.com/stellar/x402-stellar` @ `61bd87a` (2026-11-10), npm registry, developers.stellar.org.

- **Packages (npm, v2.30.0, published 2026-11-04):** `@x402/core`, `@x402/stellar`, `@x402/next`, `@x402/fetch`, `@x402/express`. The official repo now consumes these from npm.
- **Protocol (x402 v2 headers):** server → `402` + `PAYMENT-REQUIRED`; client retries with `PAYMENT-SIGNATURE`; server returns `PAYMENT-RESPONSE` (base64 `SettleResponse`, contains `transaction` = Stellar tx hash).
- **Scheme:** `exact` on network `stellar:testnet`. Payer signs a **Soroban authorization entry** for a SEP-41 token transfer; the facilitator wraps, submits and pays fees. This is not an ordinary Stellar payment op.
- **Asset:** testnet USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`), exported by `@x402/stellar` as `USDC_TESTNET_ADDRESS`.
- **Client (agent) API — mirrors the official `examples/client-cli`:**
  `createEd25519Signer(secret, "stellar:testnet")` → `new x402Client().register("stellar:*", new ExactStellarScheme(signer))` → `x402HTTPClient` with `getPaymentRequiredResponse`, `createPaymentPayload`, `encodePaymentSignatureHeader`, `getPaymentSettleResponse`.
  `x402Client` has built-in **spend controls** (default: known assets only, $1 per payment cap) plus `onBeforePaymentCreation` hooks — we layer our own NGN policy on top.
- **Server (provider) API:** `x402ResourceServer(new HTTPFacilitatorClient({url}))` `.register("stellar:testnet", new ExactStellarScheme())`, wrapped in `x402HTTPResourceServer` with `processHTTPRequest()` (402 / verify) and `processSettlement()` (settle).
- **Facilitators for `stellar:testnet`:**
  - `https://x402.org/facilitator` — live `/supported` lists `exact` on `stellar:testnet` with `areFeesSponsored: true`. No API key.
  - OpenZeppelin `https://channels.openzeppelin.com/x402/testnet` — needs an API key.
  - Self-hosted: the official `examples/facilitator` (Express, `/verify` `/settle` `/supported`), needs one Friendbot-funded key.

### Critical finding: `withX402` settles *after* the handler runs

`@x402/next`'s `withX402` verifies, **runs our route handler, then settles** only if the handler returned < 400. Using it naively would release utility before settlement — violating the core principle. **Decision:** provider routes call the lower-level `x402HTTPResourceServer` directly, in this order:

```
processHTTPRequest → (402 | verified) → processSettlement → success? → fulfil → 200 + PAYMENT-RESPONSE + receipt
```

Fulfilment code is only reachable after the facilitator returns a successful settlement with a tx hash.

## 3. System architecture

One Next.js (App Router, TypeScript) application, internally split into modules with hard boundaries. Providers are separate modules with their **own receiving wallets and own ledgers**, called by the agent over real HTTP — so the 402 handshake is genuine, and any provider can later be moved to its own service unchanged.

```
┌──────────── Browser (UI only, no keys) ────────────┐
│ Overview · Agent · Household · Transactions · Settings │
└───────────────┬────────────────────────────────────┘
                │ JSON API (Zod-validated)
┌───────────────▼──────────────── Next.js server ───────────────────────────────┐
│ usage/     simulator clock, consumption, forecasting                           │
│ agent/     deterministic decision engine → AgentDecision (snapshot, candidates,│
│            choice, reasoning, budget impact)                                   │
│ household/ budgets, policy (limits, priorities, approvals, kill switch)        │
│ payments/  x402 buyer: policy gate → fetch → 402 → sign → retry → record       │
│            (AGENT_STELLAR_SECRET lives only here)                              │
│ transactions/ purchase state machine, idempotency, receipts, recovery          │
│ providers/ electricity | airtime | data — each: x402 seller + own ledger +     │
│            fulfilment logic; /api/providers/<kind>/purchase                    │
│ database/  Drizzle schema + migrations (SQLite → Postgres-ready)               │
└──────────┬───────────────────────────────────────────────┬────────────────────┘
           │ verify / settle                                │ Soroban RPC / Horizon
     x402 facilitator  ───────── submits tx ─────────►  Stellar testnet
```

**Stack:** Next.js 16, React 19, TypeScript, Tailwind v4 with a custom token-based design system (Manrope + IBM Plex Mono, palette from the brief), Lucide, Drizzle ORM on SQLite via `@libsql/client` (prebuilt binaries — avoids native-build problems on Windows; trivially swaps to Postgres), Zod 4, Vitest, Playwright. Single process, `pnpm`.

**No background workers.** Simulation advances only via explicit server calls (`advance time`, or an "accelerated" mode where the UI calls `POST /api/sim/tick` every few seconds). Each tick runs the agent server-side. This is deterministic, survives refreshes and is easy to reset.

## 4. Payment flow (per purchase)

1. Agent engine emits a decision with one selected candidate (e.g. electricity, ₦3,000).
2. **Policy gate (backend, before any signing):** agent enabled · service + provider approved · amount ≤ per-purchase limit · ≤ remaining budget − pending commitments · ≤ overall agent limit · below manual-approval threshold (else → `awaiting_approval`). Payment destination must equal the provider's configured `payTo`; amount must equal our own price-table quote. Anything else aborts.
3. `Purchase` row created with an idempotency key; state `requested`.
4. Agent `POST /api/providers/electricity/purchase` `{purchaseId, meterId, amountNgn}` → **402** + `PAYMENT-REQUIRED`. State `payment_required`; requirements stored.
5. Requirements re-checked against our quote (asset = testnet USDC, network = `stellar:testnet`, payTo, amount, timeout). `x402Client` spend controls set to our cap as a second layer.
6. Sign auth entry server-side → retry with `PAYMENT-SIGNATURE`. State `submitted`.
7. Provider: verify via facilitator → settle via facilitator → only on `success` with a tx hash, record `ProviderSettlement` (unique on `txHash` and `purchaseId`) → release simulated utility → 200 with receipt + `PAYMENT-RESPONSE`.
8. Agent decodes `PAYMENT-RESPONSE`, then **independently confirms the tx on Horizon** (successful, correct ledger) before marking `payment_confirmed`. Fulfilment receipt recorded separately → `fulfilled`. Device balance updates.

**Pricing:** NGN is for household planning only. A fixed, clearly labelled demo price table maps NGN to testnet USDC (proposed: ₦100,000 ↔ 1.00 testnet USDC, so ₦3,000 = 0.03 USDC). It is presented as "demo pricing", never as an exchange rate, and keeps every payment far below the SDK's $1 default cap.

**Failure handling & states** — payment and fulfilment are tracked as two separate status fields, never merged:

| Case | Behaviour |
| --- | --- |
| Insufficient USDC / missing trustline | SDK throws `InsufficientBalanceError` / `TrustlineMissingError` before submission → `payment_failed`, nothing charged. |
| Invalid / mismatched requirements | Rejected by our gate before signing. |
| Expired requirements | Facilitator verify fails → `payment_failed`; agent may request a fresh 402 on the next run. |
| Facilitator down / timeout | `payment_unknown` if after submission; reconciled via Horizon lookup — never auto-retried with a new signature until resolved. |
| Settled but fulfilment failed | Provider keeps the settlement as "owed"; purchase = `payment_confirmed` + `fulfilment_failed`. "Retry fulfilment" re-calls the provider with the tx hash — no new payment. |
| Duplicate request | Same `purchaseId` returns the stored result; a tx hash can fulfil only once (unique index). Only one in-flight purchase per utility. |

Fault injection (demo/testing only, server-side flags): provider fulfilment failure, facilitator unreachable, forced expiry.

## 5. Wallets & secrets

| Wallet | Holds | Lives in |
| --- | --- | --- |
| Agent payer | XLM (Friendbot) + USDC trustline + testnet USDC | `AGENT_STELLAR_SECRET` in `.env.local`, server-only module |
| Electricity / Airtime / Data provider | USDC trustline (to receive) | public keys only in env (`*_PAYTO_ADDRESS`) |
| Facilitator (only if self-hosting) | XLM | facilitator's own `.env` |

I will add a `pnpm wallets:setup` script that generates any missing testnet keys, funds them with Friendbot, adds USDC trustlines, and writes them to `.env.local` (git-ignored). Secrets are never sent to the browser, printed, or committed. The UI shows only public addresses and the agent's authority limits.

## 6. Data model (Drizzle)

`households`, `utility_providers`, `utility_accounts` (meter / MSISDN, network), `utility_balances`, `usage_records`, `household_budgets`, `agent_policies`, `agent_decisions` (input snapshot JSON, shortages, urgency, candidates, selected action, reasoning, budget impact, outcome), `purchases` (idempotency key, payment_status, fulfilment_status), `payments` (requirements, asset, atomic amount, tx hash, facilitator response), `provider_settlements` (provider-side ledger, unique tx hash), `fulfilments`, `receipts`, `activity_events` (timeline), `demo_scenarios`. Status enums, FKs, timestamps and indexes on `(household_id, created_at)`, `tx_hash`, `idempotency_key`.

## 7. Founder decisions / manual actions

1. **Facilitator.** Recommendation: default to the public `https://x402.org/facilitator` (no key, fees sponsored, official), configurable via `X402_FACILITATOR_URL`. Fallback: run the official self-hosted facilitator locally if the public one is flaky during judging. 
2. **Testnet USDC (manual, required).** After `wallets:setup`, someone must request testnet USDC for the agent's public address at `https://faucet.circle.com` (Stellar Testnet). It uses a CAPTCHA, so I can't automate it. One request covers hundreds of demo purchases at the proposed pricing.
3. **LLM.** Recommendation: none in the core. All decisions and explanations come from deterministic templates over real data. An LLM rephrasing layer can be added later behind a flag.
4. **Git.** I will `git init` with a `.gitignore` that covers `.env*`, `*.db` and key files. I will not change your git identity or add attribution trailers.

## 8. Milestone 1 scope (next)

Next.js scaffold, DB schema, wallet setup script, electricity provider with the verify → settle → fulfil ordering, agent-side x402 buyer with the policy gate and Horizon confirmation, and a CLI/test script that runs one **real testnet purchase** end to end and prints the tx hash and explorer link. Very little UI until that works.
