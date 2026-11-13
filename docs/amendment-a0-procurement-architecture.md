# Borderless — Procurement amendment: audit and updated architecture

**Status:** proposal for founder review. No structural changes have been made yet.
**Scope:** evolve Borderless from an autonomous utility purchaser into an autonomous household **resource procurement** agent, without discarding the work from M0–M7.

The question this plan answers: *"Remove the payment from your product. If it still works the same, the payment is decoration."* For Borderless the answer must be visibly **no**: without paying, the agent cannot obtain the resources (utilities or information) it needs to finish its task.

---

## 1. What exists today (audited)

| Area | State | Evidence |
| --- | --- | --- |
| x402 utility purchases | **Genuine and working.** Six provider endpoints (two per utility) answer HTTP 402; the buyer signs, the facilitator settles on Stellar testnet, and the provider releases the utility only after settlement. Verified live many times. | `providers/purchase-handler.ts`, `payments/x402-buyer.ts` |
| No free path to a utility | **Confirmed.** The only code that credits a virtual meter or phone is `applyToDevice`, called only after a settled payment (or a no-repay fulfilment retry for an already-settled one). The simulator only drains; seeding and one demo script set starting balances. | grep of all `utility_balances` writes |
| Quotes | Free, provider-issued, 5-minute binding commitments; the purchase must redeem one. | `providers/quote-handler.ts` |
| Policy engine | Ordered 10 checks, enforced at proposal and again before signing with live wallet evidence; approval bound to exact terms with expiry; Funding guard on-chain allowance. | `household/policy.ts`, `transactions/approvals.ts`, `payments/funding-guard.ts` |
| AI agent | Gemini planner with typed tools; deterministic planner fallback; persisted run log, SSE, Agent Operations UI. Verified live with Gemini. | `agent/runtime/*` |
| Decision engine | Forecasts with confidence, prioritisation, budget sharing, options considered and rejected, "not needed" path, multi-provider choice. | `agent/engine.ts` |

**Everything above stays.** The amendment adds a procurement layer around it.

## 2. Where the architecture assumes fixed providers or fixed purchases

1. **Provider = utility seller only.** `ProviderDefinition.kind` is a `UtilityKind`; every provider "fulfils" by crediting a device. There is no notion of a provider selling *information*.
2. **Discovery is an in-process registry read.** `discover_providers` reads the code registry directly. Providers don't *publish* anything; the agent never fetches provider metadata over HTTP. This is metadata only (no free resource leaks), but it is not machine-accessible discovery.
3. **Purchases are utility top-ups.** `purchases.kind` is one of three utilities; `quantity`/`unit` describe credit; fulfilment means "device balance went up".
4. **Policy categories are utilities.** "Approved services" and per-utility caps only know electricity, airtime and data.
5. **The agent's only paid action is `purchase_utility`.** It never buys something in order to *decide* better; it only buys the end product.
6. **Unusual usage stops at a flag.** Today the agent sees "electricity use is 3× normal" and can only stop and tell the owner. It has no way to find out *why* — which is exactly where buying information is genuinely useful.

## 3. Updated architecture

```
            ┌────────────────────────── Provider network (curated, demo, clearly labelled) ─────────────────────────┐
            │  GET /api/providers                      free   registry listing (ids, names, categories, metadata URL) │
            │  GET /api/providers/:id/service          free   provider-PUBLISHED service document (untrusted data)    │
            │  POST /api/providers/:id/quote           free   binding quote (utilities)                               │
            │  POST /api/providers/:id/purchase        x402   utility credit released after settlement                │
            │  POST /api/services/:id/:service         x402   paid information released after settlement  ◀── NEW     │
            └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                     ▲ HTTP (real requests, same app for the demo)                    ▲ registered payTo = trust anchor
 Agent (buyer) ──────┘                                                                │
   observe → identify need → discover (HTTP) → evaluate (incl. "is information worth buying?")
   → quote / 402 → decide → POLICY ENGINE → approval? → sign → settle → receive resource
   → ACT ON THE RESULT → reassess
```

### 3.1 Provider network and discovery (free metadata, verified)

- **Registry (server allowlist, the trust anchor):** provider id, name, category (`utility` | `intelligence`), metadata URL, **registered payee wallet**. Only registered providers can ever be paid. Unchanged principle, extended to intelligence providers.
- **Published service document** (`GET /api/providers/:id/service`), served by each provider: description, categories, supported utilities/networks, products and denominations, public prices, availability, fulfilment terms (what is released, when), endpoints with a **`paid: true|false` flag**, payment (`exact`, `stellar:testnet`, USDC SAC, payee), and a verification block.
- **Verification:** the agent fetches the document over HTTP and code compares its payee to the registry. A mismatch marks the provider *unverified* and excludes it from purchase. All provider text is passed to the model as untrusted data (existing defence).
- **Free vs paid is explicit:** discovery, metadata and utility quotes are free; **utility credit and information results are only released through x402.** The registry never contains results, so it cannot become a free substitute.

### 3.2 First paid intelligence service: meter diagnostics

Recommended as the one intelligence service for this phase, because it fixes a real gap (item 2.6) and gives the agent a real reason to buy information *before* buying a utility.

- **Provider:** "Demo GridSense Diagnostics" (simulated, clearly labelled). Optionally a second, "Demo MeterLab" (dearer, more detailed), so the agent compares information offers too.
- **Endpoint:** `POST /api/services/prv_demo_gridsense/meter-diagnostic` — x402-protected. **The HTTP 402 is the price** (no separate quote step), which shows the pure x402 pattern alongside the quote-based utility flow.
- **What it knows that the agent doesn't:** the simulated meter records **circuit-level, high-resolution telemetry** (new provider-side table) driven by a scenario ground truth — for example a water heater stuck on, guests staying, or a faulty meter. The agent's free view remains hourly totals only. Agent tools **never** read the telemetry; only the paid endpoint does (enforced by module boundary and a test).
- **Released resource:** a structured report — finding, evidence, confidence, estimated waste per day, recommendation. Stored as the purchase's fulfilment result; shown in the inspection view.
- **Agent acts on it:** stuck load or meter fault → buy only the minimum (or nothing) and tell the owner what to fix; genuine extra usage → buy a correctly sized purchase at the new rate.

Price: ₦300 (0.003 test USDC) — small, but within the same budgets and rules.

### 3.3 Procurement decision process

- **Deterministic core (engine):** a *value-of-information* rule. Buy a diagnostic only when there is unexplained high usage on a utility that needs action **and** the diagnostic costs a small fraction of the purchase it could change (proposed ≤ 20%) **and** it is affordable within budget and the intelligence cap **and** none was bought recently. Otherwise record "information not worth buying" with the reason. The diagnostic's finding then changes the utility plan.
- **AI planner:** new tools let it make the same judgement; the system prompt asks it to decide whether information is needed and whether the cost is justified. The policy engine stays authoritative. It is never a fixed sequence: "buy nothing" is a valid outcome.
- **Rejection and deferral** are recorded with reasons ("cost unjustified", "not urgent", "outside limits", "provider unverified").

### 3.4 Judge-facing procurement inspection

For every paid acquisition (utility or information), one view showing **backend data only**:
discovered provider and its published description → protected endpoint → **raw HTTP 402** (decoded requirements) → quoted price → asset and network → policy decision (10 checks) → approval record (terms hash) → Stellar transaction → **released resource** (utility credit or report) → **the agent's next action that used it**.

Plus a **"Request without paying"** button: the server makes the same request to the protected endpoint without a payment and shows the provider's actual HTTP 402 response — the judge's test, live, in the product.

### 3.5 Stages and comparison

- Run stages gain **identifying a need** and **acting on the result**; the run console labels map to: observing → identifying a need → discovering → evaluating → requesting a quote → deciding → authorising → paying → receiving the service → acting on the result → reassessing. Only stages that actually happen light up.
- A short "How Borderless buys" panel states the **narrow, provable claim**: these provider services are designed for agent customers, and x402 is the actual payment and access mechanism implemented for them — the agent needs no human checkout. No claims about real providers or about x402 being the only possible technology.

## 4. Schema, API, tool and UI changes

**Schema (additive migrations, no data loss):**
- `utility_providers`: add `category` (`utility` | `intelligence`).
- `purchases`: add `service_type` (`utility_topup` default | `meter_diagnostic`). `kind` stays as the utility the purchase concerns; diagnostics have quantity 1, unit `report`.
- `meter_telemetry` (provider-side, hidden from agent tools): account, sim time, circuit, load. Written by the simulator when a scenario defines a load profile.
- Fulfilment result for information services stored in the existing `fulfilments`/`receipts` payload (`result` field).
- `agent_policies`: `intelligence_cap_ngn` (max per information purchase, default ₦1,000) and approval of intelligence providers via the existing provider allowlist.
- Run stages: add `identifying_need`, `using_result` (text column; additive).

**API:** `GET /api/providers`, `GET /api/providers/:id/service`, `POST /api/services/:providerId/:service` (x402), `GET /api/purchases/:id/procurement`, `POST /api/purchases/:id/probe-unpaid`.

**Agent tools:** `discover_services` (HTTP catalog + published documents, verification result), `purchase_information` (x402 direct; returns the released report as untrusted data), existing quote/purchase tools kept; `get_allocation_recommendation` includes the value-of-information judgement. Policy engine: category check covers service types; per-request cap uses the intelligence cap for information.

**UI:** Provider network page (all providers, categories, verification, free vs paid endpoints); Procurement inspection on each purchase (linked from the run timeline); stage relabelling; "How Borderless buys" panel; diagnostic report card on the run page and the household meter.

## 5. Revised milestones

| # | Milestone | Proves |
| --- | --- | --- |
| A1 | **Provider network and HTTP discovery** — registry listing, published service documents, payee verification, discovery tools over HTTP; utility flow unchanged | Criteria 2, 3, 11 |
| A2 | **Paid meter diagnostics** — provider-side telemetry and ground truth, x402 endpoint, generalised purchases, policy for information purchases, released report | 4, 5, 6, 7, 8 |
| A3 | **Procurement decisions** — value-of-information in engine and AI tools, acting on results, scenarios: *stuck heater* (buys diagnostic, then minimal/no electricity), *guests* (diagnostic then correctly sized purchase), *not worth it* (declines to buy information) | 1, 9, 10, 11 |
| A4 | **Judge-facing inspection** — procurement view, "request without paying", stage labels, comparison panel | 12, 13, 14 |
| A5 | **Validation and docs** — unit, e2e and live testnet proofs (including a live Gemini run of the diagnostic scenario), README | all; 15 (existing capabilities intact) |

Each milestone ends with tests, live proof where relevant, and a report, as before.

## 6. Risks and how they're handled

- **Scope creep:** one intelligence service (optionally two competing diagnostic providers); no marketplace, no MPP, no new contracts.
- **"Simulated" honesty:** diagnostics and telemetry are simulated and labelled; the provider is a separate module reached over real HTTP and paid on Stellar testnet. The demo never claims a real meter was inspected.
- **Free substitutes:** a test fails the build if any agent tool or view reads the telemetry table or calls a provider's internal fulfilment code.
- **Model credit:** the extra tools add a little prompt size; tool results stay capped. Live AI runs only at milestone proofs.
- **Existing flows:** the utility x402 flow, policy engine, approvals and Funding guard are reused, not rewritten; full regression suites run at each milestone.

## 7. Decisions for the founder

1. **Meter diagnostics as the first intelligence service** (recommended) — rather than outage forecasts, which are harder to make decision-relevant honestly.
2. **Add a second, competing diagnostic provider** (recommended, small), so the agent also compares information offers.
3. **Discovery over real HTTP inside the same app** (recommended for the demo), with providers still separable into their own services later.
4. **Utility quotes stay free; information is priced directly by its HTTP 402** (recommended).
5. **Information purchases within the ₦1,000 intelligence cap run without owner approval** (recommended), still subject to all other limits.
