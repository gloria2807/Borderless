# Borderless — Agent & x402 Upgrade: Milestone 0 Engineering Assessment

_Date: 13 Nov 2026. Scope: audit and research only. No code was changed._

**Sources studied:** the workshop deck *Agentic Payment & x402 on Stellar* (25 pages); the reference kit `KoxyG/x402-stellar-empower-Her` @ `52e5ec2` (every source file) and its demo result; the official Stellar *agentic-payments* skill (via the Stellar Raven MCP); Stellar Docs (via the Stellar Docs MCP) — x402, MPP, *Delegate spending*, the agent-CLI *Authority model*, *Building with AI*; live facilitator `/supported` endpoints; current npm registry versions.

---

## Executive summary

1. **Borderless's payment layer is already genuine x402 and is its strongest asset.** Providers return a real `402` from the official `x402HTTPResourceServer`. The buyer signs a Soroban auth entry with the official `x402Client`. The x402.org facilitator verifies and settles. Fulfilment happens strictly *after* settlement, and every payment is independently confirmed on Horizon. This is stricter than the workshop kit, whose Express middleware runs the handler before settling.
2. **The single largest gap is that there is no AI agent.** Today's "agent" is a well-built deterministic decision engine. It decides and explains, but it doesn't interpret a task, choose tools or adapt. By the workshop's own definition it is closer to the "scripted client" than to an agent, even though it is far smarter than a fixed script. This is the core of the upgrade.
3. **Several controls in the brief don't exist yet:**
   - daily agent budget, per-task (per-run) budget and minimum reserve;
   - a wallet-balance check before signing;
   - approval expiry, with approval bound to the exact quote;
   - multiple competing providers per utility, with quotes to compare;
   - run IDs, Server-Sent Events streaming and persisted per-run execution events;
   - prompt-injection defences, which aren't needed yet because there's no model yet.
4. **Recommended architecture: "the AI proposes, the code decides".**
   - **Planner:** Claude (`@anthropic-ai/sdk`) runs a manual tool-use loop on the server.
   - **Tools:** it gets about 12 typed tools that read real household state and request purchases.
   - **Decisions:** every purchase passes through one deterministic, ordered policy engine, then the existing x402 buyer. The model never holds a key, never sees a secret, and can't change a limit.
   - **Visibility:** each run is persisted as an ordered event log and streamed to an Agent Operations console over Server-Sent Events.
5. **On-chain allowance: worth adding, with an honest framing.** x402's `exact` scheme makes the payer sign a `transfer` from **its own** balance. A Stellar token allowance (`approve` / `transfer_from`) therefore **cannot gate the x402 payment itself**. What it can do is cap how much the agent's small "float" wallet can **draw from a household treasury**, with a network-enforced cap and expiry. Worst-case loss becomes the float plus the remaining allowance until expiry, enforced by Stellar rather than by our code. Details in §6.
6. **MPP:** don't implement it. Each utility purchase is a discrete, meaningful transaction, which is exactly what x402 is for. MPP Session mode becomes relevant only if Borderless starts paying per metered call (§10).
7. **Founder action required:** an **Anthropic API key**. Nothing else is required; all other wallets and setup can be automated, as they are today.

---

## 1. Current application architecture

One Next.js 16 (App Router, TypeScript) application, with SQLite through Drizzle and server-only modules:

| Module | Today |
| --- | --- |
| `server/payments/x402-buyer.ts` | Official `x402Client` + `x402HTTPClient`; validates 402 requirements against our own quote; spend controls and a policy filter; server-side signing; Horizon confirmation; recovery. |
| `server/providers/*` | Provider-module contract with an electricity, airtime and data module, a shared x402 seller, a settlement ledger (unique tx hash), the fulfilment retry endpoint, and fault injection. Endpoint: `POST /api/providers/[kind]/purchase` — **one provider per utility**. |
| `server/agent/engine.ts` | Deterministic urgency × priority ranking, product sizing, budget sharing, every candidate checked against policy. |
| `server/agent/explain.ts` | Typed explanation lines (fact, observation, prediction, decision, constraint). |
| `server/agent/run.ts` | Snapshot → decide → persist decision → create purchases → execute. Synchronous: the HTTP request blocks for the whole run. |
| `server/household/policy.ts` | `evaluateSpendingAuthority`: per-purchase limit, household budget including commitments, overall agent limit, approval threshold, approved services, networks and providers. |
| `server/usage/*` | Forecasting (observed vs baseline rate, expiry, urgency, anomaly) and a deterministic simulator. |
| `server/transactions/*` | Purchases, approvals, interrupted-purchase sweep, activity events. |
| UI | Overview (service runway), Agent, Household (virtual devices), Transactions, Settings, Demo controls. "Live" updates come from refreshing the page every 1.2 s while an action runs, **not** from a stream. |

## 2. What already works (proven live on testnet)

- **Payments:** genuine 402 → sign → facilitator verify and settle → fulfil-after-settle → Horizon confirmation, for all three utilities. There are more than 15 settled testnet transactions from the M1–M5 runs.
- **Failures and recovery:**
  - Failures before submission are reported honestly: insufficient testnet USDC, a missing trustline, mismatched requirements, a facilitator failure during verification.
  - Provider failure after payment, followed by a retry that doesn't pay again.
  - Replaying a completed purchase is idempotent, and one open purchase per utility is enforced.
  - The sweep closes interrupted purchases after a restart.
- **Agent engine and demo:** deterministic allocation that is budget- and priority-aware, honest explanations, and six demo scenarios.
- **Tests:** 131 unit and integration tests, 18 Playwright tests including axe-core accessibility checks, and the live end-to-end payment journey.

## 3. Missing capabilities, against the new brief

| Area | Gap |
| --- | --- |
| **AI agent** | No language model. Nothing interprets a task, chooses tools, or adapts to a refusal or outage. |
| **Discovery and comparison** | One provider per utility and a fixed catalogue; no quotes, no offers to compare. |
| **Spending controls** | Missing: daily agent budget, per-task budget, minimum reserve, wallet balance check, maximum per utility, explicit recipient allowlist, quote-validity check. |
| **Approval** | No expiry; no binding to an exact quote, recipient and provider; approval doesn't resume a paused run. |
| **Execution model** | Runs are synchronous inside one HTTP request. No run ID, no background execution, no resume. |
| **Events** | The activity log has no run ID, stage, tool, input or result summaries, or sequence numbers. No Server-Sent Events. |
| **Transaction records** | No agent run ID, no explicit fulfilment reference, and receipts aren't searchable. |
| **Prompt injection** | Not applicable yet. Needs data and instruction separation, tool-argument validation, and adversarial tests. |
| **UI** | No live Agent Operations console, no expandable stages, no per-run approval card, no separate Utility Accounts view, no transaction search. |
| **Demo** | No wallet-balance scenario, no "agent decides a purchase is unnecessary" scenario, no provider-competition scenario. |

## 4. Is the payment implementation genuinely x402?

**Yes.** Verified against the official skill and docs:

- **Network and asset:** `stellar:testnet` (CAIP-2), the `exact` scheme, x402 **v2** headers (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`), and USDC SAC `CBIELTK6…DAMA` for `asset` with a classic `G…` address for `payTo`. All match the skill's *Two USDC addresses* rule.
- **Facilitator:** `https://x402.org/facilitator` lists `{"x402Version":2,"scheme":"exact","network":"stellar:testnet","extra":{"areFeesSponsored":true}}` in its `/supported` response, checked today.
- **Safety layers:** the buyer already implements the workshop's three layers. Layer 1 is our rules; Layer 2 is `setSpendControls` plus `registerPolicy`, accepting only the requirements that exactly match our quote; Layer 3 is the wallet balance.
- **One improvement:** add an explicit wallet-balance policy check (step 9 of the brief's order), rather than relying on the SDK's simulation error.

**Versions:**
- `@x402/*` **2.31.0** was published on 12 Nov 2026 (yesterday). Borderless runs **2.30.0**, which is live-proven. I recommend staying on 2.30.0 and upgrading after a 7-day soak, which matches the policy of the official `x402-stellar` repository. Release notes should be checked at that point.
- `@stellar/stellar-sdk` 17.4.0 is current.

**Alternative facilitators**, if x402.org has problems during judging: AgentSmith testnet (no key needed per the official skill; its `/supported` answered HTTP 200 today, but I haven't yet checked that it lists `stellar:testnet`) and OpenZeppelin Channels (needs a key). The facilitator is one setting, `X402_FACILITATOR_URL`.

## 5. Is the AI agent genuine?

**There is no AI agent.** The deterministic engine is strong, and should be **kept as the authoritative core**:
- **Allocation:** it is the authoritative allocation logic.
- **Fallback planner:** it runs when no model is available, labelled honestly as "Deterministic planner (no AI)".
- **Model input:** its urgency scores and recommended plan become one input the model can consult and disagree with.

The model then adds what the brief asks for: interpreting a task, choosing tools, comparing provider offers, recovering from refusals and outages, and explaining its decisions from real tool results.

### Reference kit — what to adopt and what to avoid

**Adopt:**
- The model is not told its exact limits ("it learns a limit when it hits it").
- Tool paths are validated against an allowlist pattern.
- Tool output is treated as data.
- A step cap stops runaway loops.
- An AI outage stops the run safely.

**Avoid:**
- Approval isn't bound to the quote. The kit only filters on "amount ≤ approved".
- Events are in memory and lost on refresh.
- The paid handler runs before settlement.
- Only a single global pending approval is possible.
- Money is handled as floating-point USD.

## 6. Security gaps and the on-chain allowance

**Gaps to close:**
- No daily or per-task budget.
- No reserve.
- No wallet-balance check before signing.
- No approval expiry or quote binding.
- No recipient allowlist beyond "the account's own identifier".
- Mutating routes have no authentication, only the same-origin check. That's acceptable for a local demo, and documented.
- With a model introduced: prompt injection through provider text, a model proposing out-of-scope tool arguments, and a model attempting to "approve" itself.

**On-chain allowance** (Stellar *Delegate spending*, Pattern 2):
- **Who owns the funds:** a household **treasury** account. It's a testnet key the setup script generates, and in a real deployment it would be the owner's wallet.
- **Who controls the agent:** the agent's **float** wallet. That's the key Borderless holds, and it pays x402 from its own balance.
- **What is delegated:** `token approve` grants the float a USDC allowance with a cap, for example 2 USDC, and an expiry ledger, for example about 7 days.
- **How it's used:** before a payment that would leave the float below a threshold, Borderless calls `transfer_from` on the treasury to top the float up. Stellar rejects any draw over the cap (`Error(Contract, #9)`) or past the expiry.
- **Verification:** `token allowance` is read back and shown in Settings, as amount, expiry ledger and estimated time.
- **Revocation:** the owner approves `0` (one click in Settings, signed by the treasury key on the server for the demo). The next top-up then fails at simulation, and nothing reaches the network.
- **If the agent key is compromised:** the worst case is the float balance plus the remaining allowance until expiry. **That bound is enforced by Stellar, not by Borderless's code.**
- **What it doesn't do:** it doesn't restrict *where* the float pays, so it is not a destination allowlist. It also doesn't cap individual x402 payments. Those remain the policy engine's job. The docs list both gaps explicitly.

**Recommendation:** implement it in Milestone 6 as **"Funding guard"**. It uses the built-in Stellar Asset Contract `approve`, so no custom contract is needed. It gives judges a genuinely network-enforced limit while staying honest about what it covers.

## 7. UI and UX improvements

- **Agent Operations (replaces `/agent`):**
  - Run controls with a task box, a mode ("AI agent" or "Deterministic planner") and the model used.
  - A live, stage-labelled timeline over Server-Sent Events, covering *Observing*, *Analysing*, *Discovering*, *Comparing*, *Deciding*, *Requesting payment*, *Checking spending rules*, *Awaiting approval*, *Signing*, *Settling on Stellar*, *Verifying fulfilment*, *Updating household* and *Reassessing*.
  - Expandable step panels (observation, forecast, discovery, decision, payment, fulfilment) showing **only stored backend fields**.
  - An inline approval card with a countdown.
  - A run summary and a list of past runs that works after a refresh.
- **Overview:** add the current run's status, outstanding approvals and the latest run summary.
- **Utility Accounts (new):** meter and MSISDN records, network, approved recipients, the providers serving each account.
- **Transactions:** search and filter (utility, status, provider, tx hash), plus agent run ID and fulfilment reference columns.
- **Settings:**
  - Add a daily budget, a per-task budget, a reserve, a maximum per utility, approval expiry, and provider approval per provider.
  - Add Funding guard: the allowance, its expiry, and revocation.
  - Add the planner mode.
- **Labels everywhere:** STELLAR TESTNET, TEST USDC, SIMULATED UTILITY ACCOUNT, SIMULATED PROVIDER FULFILMENT.
- **Keep the existing design system:** palette, Manrope and IBM Plex Mono, the service runway, and the restrained surfaces.

## 8. Recommended implementation architecture

```
                  Agent Operations UI ◀── SSE: GET /api/agent/runs/:id/events (replays from DB, then live)
                         │ POST /api/agent/runs { task, mode }      POST /api/approvals/:id { decision }
                         ▼
┌──────────────────────── Run executor (server, background, one run per household) ────────────────────────┐
│ Planner: Claude tool-use loop (AI)  ─or─  Deterministic planner (fallback)                                │
│   tools ─▶ Tool layer (typed, Zod-validated, read real DB state) ──▶ event log (agent_run_events)          │
│                 │ propose_purchase / purchase_utility                                                     │
│                 ▼                                                                                         │
│   Policy engine (ordered, pure, authoritative)                                                            │
│   1 provider approved · 2 category allowed · 3 recipient permitted · 4 quote valid & unchanged ·          │
│   5 per-request cap · 6 task budget · 7 daily budget · 8 household budget incl. reserve & commitments ·   │
│   9 wallet balance (Horizon) · 10 approval required?  → allow | require_approval | deny (full trace)      │
│                 │ allow                     │ require_approval → approval bound to quote hash, TTL;       │
│                 ▼                           │   run pauses; expiry or decline = no payment                │
│   x402 buyer (existing) → provider 402 → requirements must equal quote → sign → retry →                   │
│   facilitator verify + settle → provider fulfils AFTER settlement → Horizon confirmation → receipt        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
Providers: POST /api/providers/:providerId/{quote|purchase}   (2 per utility, own payTo wallet each)
```

**Key design decisions:**
- **Model and loop:** Claude through the official `@anthropic-ai/sdk` (1.8.0), in a **manual tool-use loop** so every tool call passes our event log and guards.
  - Model: `claude-opus-5-5` by default, configurable with `AGENT_MODEL`.
  - Adaptive thinking is on, with effort `medium` (the model's default, set explicitly).
  - Tool choice is `auto`; tools use `strict: true` schemas.
  - The model's thinking is not shown. Only the summaries it states and the actual tool results are shown, so no private chain of thought is fabricated.
  - Refusal stop reasons are handled, with server-side fallback enabled.
  - Per-step and total-run timeouts apply, with a step cap.
- **Tools, adapted to our modules rather than duplicated:** `observe_household`, `inspect_utility` (balance, consumption and forecast with confidence), `inspect_budget`, `discover_providers`, `request_quote`, `compare_offers` (deterministic scoring the model can see), `get_allocation_recommendation` (the existing engine, advisory), `propose_purchase` (policy check without payment), `purchase_utility` (policy → approval → x402 → fulfilment), `inspect_transaction`, `verify_fulfilment`, `reassess_household`, and `finish` (structured summary).
- **The model can't:**
  - name a URL, a payTo address, an amount outside a returned quote, a recipient not on the account, or a provider not in the catalogue;
  - change settings;
  - approve;
  - mark anything as successful.

  Every argument is Zod-validated and resolved against the database, never trusted.
- **Quotes:** a free provider endpoint issues `{quoteId, providerId, product, amountNgn, atomicUsdc, payTo, expiresAt}`. The purchase order carries the `quoteId`. The provider re-derives the price and the buyer checks the 402 against the quote. If anything changes, approval is required again.
- **Approvals:** a table records exactly what was approved (purchase, provider, recipient, quote, amount and a hash of all of these), with a `pending` / `approved` / `declined` / `expired` status. The time limit (TTL) is enforced on the server, and a run awaiting approval stays paused. Only the owner's endpoint can approve; there is no model tool for it.
- **Events:** an append-only `agent_run_events` table holds `{runId, seq, at, stage, type, utility, tool, inputSummary, resultSummary, decision, reason, paymentStatus, txHash, error}`. The Server-Sent Events endpoint replays from the database (`Last-Event-ID`) and then streams new rows, so a refresh or restart loses nothing.
- **Restart safety:** runs and events are persisted. On boot, any run left `running` is marked `interrupted`, and the existing sweep reconciles its purchases.
- **Prompt injection:**
  - Provider text is returned to the model inside tool results, marked as untrusted data.
  - The system prompt states that tool data is never an instruction.
  - The policy engine blocks out-of-policy actions regardless.
  - A demo "injection" provider is added, along with adversarial unit tests that use a mocked model client.

**What stays the same:** the x402 seller and buyer, settlement ledger, fulfilment, Horizon confirmation, forecasting, simulator, design system and existing tests. Changes are additive and incremental, not a rewrite.

## 9. Dependencies, environment variables and credentials

| Item | Status |
| --- | --- |
| `@anthropic-ai/sdk` 1.8.0 | new dependency |
| **`ANTHROPIC_API_KEY`** | **Founder action required.** Server-side only, never sent to the browser. |
| `AGENT_MODEL` (default `claude-opus-5-5`), `AGENT_MAX_STEPS`, `AGENT_RUN_TIMEOUT_SECONDS`, `AGENT_MODEL_TIMEOUT_SECONDS` | new; defaults in `.env.example` |
| `APPROVAL_TTL_SECONDS`; daily and per-task budgets, reserve and maximum per utility | new; stored in the database, editable in Settings |
| Extra provider wallets (2 per utility) and a treasury wallet for Funding guard | generated, funded and given trustlines by `pnpm wallets:setup` (extended); no manual step |
| Facilitator | unchanged (x402.org); AgentSmith documented as a fallback |

**Model cost:** at Claude Opus 5.5 prices ($4 / $20 per million tokens), an agent run of about 10 tool steps should cost in the order of cents. Claude Sonnet 5.5 is a cheaper option if you prefer; that's your call, and it's a single setting.

## 10. MPP — evaluated, not implemented

MPP Charge settles each request without a facilitator. MPP Session opens a payment channel once and then makes many off-chain payments.

Borderless's purchases are discrete, valuable and infrequent (a few per day per household), and each should have its own on-chain receipt. That makes **x402 the right protocol**. MPP Session would fit a future where Borderless pays per *metered* call: for example, per-minute consumption telemetry from a smart-meter API, or a tariff-optimisation service queried thousands of times a day.

The upgrade path would be to add an `@stellar/mpp` session client beside the x402 buyer, behind the same policy engine. Implementing it now would add a contract deployment and complexity for no demonstrable benefit, so it will be documented in the README instead.

## 11. Prioritised milestones

| # | Milestone | Outcome | Proof |
| --- | --- | --- | --- |
| 1 | **Genuine AI agent** | Claude planner, tool layer, run executor, ordered policy engine (all 10 checks), deterministic fallback | Unit tests with a mocked model (tool selection, refusal recovery, malicious tool calls); one live run against real state |
| 2 | **x402 with quotes** | Provider-ID endpoints, a free quote endpoint, quote-bound purchases; electricity first | Live testnet purchase driven by the AI, tx verified on Horizon |
| 3 | **Provider expansion** | Two providers per utility (airtime, data), discovery and comparison, a provider outage the agent recovers from | Live purchases; a recovery scenario |
| 4 | **Household intelligence** | Forecast confidence, per-utility caps, reserve, a "purchase not needed" path, decision records with options rejected | Engine and scenario tests |
| 5 | **Agent Operations** | Run events and Server-Sent Events, the stage timeline, expandable details, approval card with TTL, refresh-safe history | Playwright: the stream reflects backend events, approval and expiry |
| 6 | **Resilience** | Approval binding and expiry, model timeout, restart-during-run, Funding guard allowance, malicious-provider tests | Integration and live tests |
| 7 | **Polish and demo** | Utility Accounts page, transaction search, new scenarios (constrained budget, refusal or deferral, insufficient wallet, injection attempt), README, full validation | Full test suites + live end-to-end |

**Risks:**
- The model's tool choices can vary between runs. This is mitigated by deterministic tests with a mocked model, a demo prompt the agent is reliably able to handle, and the deterministic fallback.
- Testnet resets. Handled with `wallets:setup`.
- Facilitator availability. The facilitator is a single setting to switch.

---

**To start Milestone 1, I need:** your approval of this architecture, and an `ANTHROPIC_API_KEY` added to `.env.local`. Without the key I can build and test Milestone 1 fully against a mocked model, but I can't prove a live AI run.
