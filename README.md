# Borderless

**An autonomous household utilities agent that keeps a home powered and connected, and pays for what it needs through x402 on Stellar.**

*Your household stays powered and connected. Borderless handles the rest.*

**Live demo:** [teamborderless.vercel.app](https://teamborderless.vercel.app). No setup needed; start at [/overview](https://teamborderless.vercel.app/overview).

`x402 v2` · `@x402/core` + `@x402/stellar` · `exact` scheme · `stellar:testnet` · USDC · Next.js 16

<p align="center">
  <img src="docs/images/overview.png" alt="Borderless Overview: the Okafor Household's electricity, spending authority and Simulate low balance" width="900">
</p>

> Every payment in Borderless is a real transaction on **Stellar testnet** in **test USDC**, which has no monetary value. The electricity meter, phone lines and providers are simulated, and prices in naira are converted at a fixed, labelled demo rate of **₦1,000 = 1 test USDC**.

---

## When the light goes off and the data follows

In Nigeria today, life is expensive and money is tight. Prices go up almost every week but salaries don't, so most families plan how every naira will be spent before it even comes in. Light and data come out of that same small budget with food and transport, yet they are the two things a home can't do without, especially if you work from home or run a business from your phone, because when either one runs out you can miss a deadline or lose a client.

And it always seems to happen at the worst moment. You are in the middle of a call or about to submit something important when the power goes off, and you assume it is NEPA (what many Nigerians still call the power company) until you check the meter and see your units have finished, then reach for your phone to buy more and find your data is almost gone too. Wherever you live, you probably know that feeling of sitting with not quite enough money and two needs, working out which one you can bear to go without. Borderless was built so that nobody has to make that choice in the dark.

## What Borderless does

Borderless keeps an eye on the household's electricity meter and phone lines, forecasts when each will run out, finds the providers that can serve the home and compares what they offer. Within the budget, priorities and limits the owner has set, it decides what to buy, pays the provider itself through x402 on Stellar, checks that what was paid for actually arrived, and explains its reasoning in plain language.

When there isn't enough to cover everything, it pays for what matters most and holds off on the rest. When usage suddenly jumps, it can pay a few hundred naira for a meter diagnostic to understand why before spending more on electricity. And when spending would be a mistake, it waits or asks the owner first.

## Naira on the surface, Stellar underneath

A fair question is why a family that earns, saves and thinks in naira would use a product built on Stellar. The answer is that they don't have to change how they think about money at all. Borderless shows every price in naira, the owner sets limits and priorities in amounts that make sense to them, and nobody needs to understand wallets, tokens or blockchains for the light to come back on.

Stellar does its work underneath. Each purchase is paid in USDC on Stellar, which settles in a few seconds for a tiny fraction of a cent, works at two in the morning as well as at noon, and doesn't depend on a card, a bank's opening hours or a failed transfer that takes days to reverse. A budget held in a dollar-backed stablecoin also holds its value from week to week in a way that cash put aside for bills often doesn't.

We believe this is how the blockchain reaches the people who stand to gain the most from it. Rather than asking a nurse in Ibadan or a remote developer in Lagos to become a crypto user, Borderless quietly makes the bills they already pay easier, cheaper and fairer to pay, and every household it serves becomes a Stellar user without having to think about it. In production, a household would fund its budget in naira through a Stellar anchor, the regulated on and off ramps that connect local bank accounts to USDC; in this demo, the fixed rate of ₦1,000 = 1 test USDC stands in for that step.

---

**Demo video (1:58):** 

https://github.com/user-attachments/assets/aca179a1-06cf-4b2a-ab56-5d7c71e0a13a





## How x402 on Stellar powers Borderless

Every electricity top-up, airtime or data bundle and paid meter diagnostic sits behind a provider endpoint that answers **HTTP 402 Payment Required**. The provider releases nothing until a Stellar payment has been verified and settled, so the payment isn't a checkout bolted onto an AI app; it is part of the request that gets the job done. The app even has a **Request without paying** button that sends the same request with no payment and shows the provider's real 402.

Borderless implements both sides of x402 with the official `@x402/core` and `@x402/stellar` packages (2.30): eight demo providers act as sellers, each with its own receiving wallet and x402 resource server; the agent's server-side wallet is the buyer and the only code that holds a signing key; and the public facilitator at `https://x402.org/facilitator` verifies and settles each payment on Stellar testnet and sponsors the fee.

<p align="center">
  <img src="docs/images/x402-integration.png" alt="The three x402 integration points: the provider protects its endpoint, Borderless pays within policy, the resource is released only after settlement" width="900">
</p>

### Where it lives in the code

| Role | File | What it does |
|---|---|---|
| Seller: protect the endpoint | [`x402-seller.ts`](src/server/providers/x402-seller.ts#L69-L113) | Each provider builds an `x402ResourceServer` with `ExactStellarScheme` and an `x402HTTPResourceServer` route: `exact` scheme, `stellar:testnet`, `payTo` set to its **registered** wallet, and a price in USDC taken from its own quote. |
| Seller: settle, then release | [`purchase-handler.ts`](src/server/providers/purchase-handler.ts#L141-L230) | An unpaid request gets `402` with `PAYMENT-REQUIRED`. A paid one goes through `processHTTPRequest` (verify), then `processSettlement` (settle on Stellar); the unique transaction hash is recorded and only then is the utility released. |
| Seller: paid information | [`service-handler.ts`](src/server/providers/service-handler.ts) | Meter diagnostics (₦300 = 0.30 USDC, or ₦800 = 0.80 USDC), where the 402 itself is the price. |
| Buyer: pay within policy | [`x402-buyer.ts`](src/server/payments/x402-buyer.ts#L128-L136) | `x402Client` with `ExactStellarScheme`, an SDK spending cap, and a policy that only accepts payment terms identical to Borderless's own quote. |
| Buyer: the purchase | [`executePurchase`](src/server/payments/x402-buyer.ts#L150-L500) | Expects the 402, checks it against the quote, runs the policy engine again with the live wallet balance, signs a Soroban authorisation entry on the server and retries with `PAYMENT-SIGNATURE`. |
| Independent proof | [`horizon.ts`](src/server/payments/horizon.ts#L42) | Confirms the USDC transfer on Horizon (sender, recipient, amount) instead of trusting the provider's word. |
| Spending rules | [`policy.ts`](src/server/household/policy.ts#L194) | `evaluateSpendingAuthority`: the ordered checks every payment must pass before it can be signed. |
| The agent's only way to pay | [`tools.ts`](src/server/agent/runtime/tools.ts#L608) | `buy_service` accepts only a `quote_id` from the current run, so the model can never name an amount or a payee. |
| The HTTP endpoints | [`purchase/route.ts`](src/app/api/providers/%5BproviderId%5D/purchase/route.ts), [`[service]/route.ts`](src/app/api/services/%5BproviderId%5D/%5Bservice%5D/route.ts) | The x402-protected routes, reached over real HTTP even by the agent inside the same app. |

### How a payment flows

```mermaid
sequenceDiagram
    autonumber
    participant A as Borderless agent
    participant P as Policy engine
    participant S as Provider (x402 seller)
    participant F as x402 facilitator
    participant X as Stellar testnet

    Note over A,S: Stage 1 · Quote and first check
    A->>S: Request a quote (free)
    S-->>A: Binding quote with product, price in naira and USDC, payee, 5-minute expiry
    A->>P: Check provider, payee, caps, budgets and approval
    P-->>A: Allowed

    Note over A,S: Stage 2 · Payment required
    A->>S: Purchase request without payment
    S-->>A: HTTP 402 with the PAYMENT-REQUIRED terms
    A->>A: Confirm the 402 matches the quote exactly
    A->>P: Check again with the live wallet balance
    P-->>A: Allowed
    A->>A: Sign the payment (the key never leaves the server)

    Note over A,X: Stage 3 · Settle on Stellar, then release
    A->>S: Retry with PAYMENT-SIGNATURE
    S->>F: Verify and settle the payment
    F->>X: Submit the USDC transfer
    X-->>F: Transaction hash
    F-->>S: Settled
    S->>S: Record the hash, then release the utility
    S-->>A: 200 OK with receipt and PAYMENT-RESPONSE
    A->>X: Confirm the transfer independently on Horizon
```

The agent notices from real household data that, say, the meter has about a day left. It discovers the eligible providers, gets a binding quote and runs it past the policy engine. The provider answers with a 402, and Borderless refuses to sign anything that differs from the quote, then checks the owner's rules once more against the live wallet balance before signing. The facilitator verifies and settles the payment on Stellar, the provider credits the meter and issues a receipt, and Borderless confirms the transfer on Horizon and reassesses the household. Payment and delivery are recorded separately, so if a provider is paid but fails to deliver, the purchase can be completed later without paying twice.

<p align="center">
  <img src="docs/images/run-console.png" alt="A live agent run: every stage lit from recorded backend events, payment confirmed and utility released" width="900">
</p>
<p align="center"><sub>A live run. Each stage lights up only when the server records it: discover, decide, spending rules, HTTP 402, sign, settle on Stellar, release, verify.</sub></p>

**Proof from a real run:** in Scenario A, Borderless paid 2.0000000 test USDC to the electricity provider's registered wallet in transaction [`46846b41…2c73`](https://stellar.expert/explorer/testnet/tx/46846b41a6735355b153f0213a84d3e86655cb355f0a40376ca25672da232c73) (ledger 5,780,559), and only then did the provider credit the meter.

<p align="center">
  <img src="docs/images/stellar-expert.png" alt="Stellar Expert: the 2 USDC transfer from the agent wallet to the provider wallet on testnet" width="820">
</p>

### What it makes possible

Take x402 away and Borderless stops being an agent and becomes a dashboard that predicts when the light will go off and sends a reminder, leaving the person in the dark to do the rest.

| What Borderless needs | Why only x402 on Stellar gives it |
|---|---|
| **To pay without a human** | Card forms, one-time codes and vendor accounts are built to stop software from paying. With x402 the provider states its terms in a 402 and the agent answers with a signed payment, at any hour. |
| **To pay any provider it finds** | Borderless discovers providers at runtime and pays the one that serves the home best. Any provider that speaks x402 can be paid, with no contract, API key or onboarding in advance. |
| **Small payments that make sense** | Paying ₦300 for a meter diagnostic before deciding how much electricity to buy only works when the fee is a tiny fraction of a cent and settlement takes seconds. |
| **No payment, no product** | The provider releases the utility only after settlement, so neither side has to trust an unpaid promise. |
| **A checkpoint for the owner's rules** | The 402 states the exact scheme, asset, payee and amount before anything is signed, which gives the policy engine a precise moment to compare them with the quote and the owner's limits. |
| **Proof anyone can check** | Every purchase is its own Stellar transaction, confirmed by Borderless on Horizon and open to anyone on Stellar Expert. |

Borderless uses x402 rather than a payment channel because a household makes a handful of distinct purchases a day, each with its own quote, approval and receipt, which is exactly x402's one-payment-per-request model.

---

## The owner stays in control

*The AI proposes. The code enforces.* The model chooses which tools to use and what to buy, but it can never set an amount, choose a payee, change a limit or approve its own purchase. A deterministic policy engine checks every purchase twice, once when it is proposed and again with the live wallet balance just before signing. Anything above the owner's hard limit is refused before a signature exists, anything above the automatic threshold waits for the owner to approve the exact terms, and **Pause** or **Emergency stop** in Settings halts spending at once.

The demo household belongs to Adaeze Okafor, who lets Borderless pay up to 2 USDC on its own, up to 4 USDC per request with her approval, and up to 10 USDC a day, with electricity first, then data, then airtime.

<table>
<tr>
<td width="50%"><img src="docs/images/competing-needs.png" alt="Scenario B: 2 USDC left, electricity bought and data deferred"><br><sub><b>Competing needs.</b> With 2 USDC left and both electricity and data running low, it buys electricity, the owner's first priority, and explains why data can wait.</sub></td>
<td width="50%"><img src="docs/images/policy-refusal.png" alt="Scenario C: over-limit purchase refused before signing"><br><sub><b>Over the limit.</b> A 5 USDC purchase is refused before signing, naming every rule it broke. Nothing reaches Stellar.</sub></td>
</tr>
</table>

---

## Try it

You don't need real money, a wallet or an API key; every payment uses test USDC on Stellar testnet.

**Live:** open **[teamborderless.vercel.app/overview](https://teamborderless.vercel.app/overview)**. It runs the same code as this repository. The live site has one shared demo household, so if someone else's run is in progress yours waits for it to finish, and **Reset demo** resets the household for everyone.

| # | Do this | What you'll see |
|---|---|---|
| 1 | On `/overview`, press **Reset demo**, then **Simulate low balance** | A real agent run in its live console: forecast, discover, decide, spending rules, HTTP 402, sign, settle on Stellar, release, verify. About a minute. |
| 2 | Open the purchase, then **Inspect procurement** | The decoded 402, every policy check, the released units and the transaction on Stellar Expert. |
| 3 | Press **Request without paying** | The provider's live 402. Without payment, nothing is released. |
| 4 | Demo controls → **B · Competing needs**, then **Start run** | Electricity bought, data deferred, with the reasoning. Put data first in Settings and run again to see the money follow the owner's priorities. |
| 5 | Demo controls → **C · Spending limit**, then **Attempt over-limit purchase** | Refused before signing. No payment, no transaction. |

**See the 402 from your terminal** (free, because nothing is paid):

```bash
curl -i -X POST https://teamborderless.vercel.app/api/services/prv_demo_gridsense/meter-diagnostic -H "content-type: application/json" -d '{"accountIdentifier":"45012345678","purchaseId":"pur_judgetry000001"}'
```

The response is `402 Payment Required`, and its `payment-required` header decodes (Base64) to the x402 v2 terms: `exact` scheme on `stellar:testnet`, 3000000 units of USDC (0.30, 7 decimals), payable to the provider's registered wallet, with fees sponsored.

**Locally** (about 10 minutes, with Node.js 22.23.4 or later and pnpm 10):

```bash
git clone https://github.com/gloria2807/Borderless.git
cd Borderless
pnpm install
cp .env.example .env.local     # on Windows PowerShell: copy .env.example .env.local
pnpm wallets:setup             # creates and funds its own testnet wallets
pnpm db:reset                  # loads the demo household
pnpm dev                       # http://localhost:3000
```

A Gemini or OpenAI key in `.env.local` turns on the AI planner; without one, a deterministic planner uses the same tools, rules and real payments. `pnpm check` runs the typecheck and 318 unit and integration tests, with no network or funds needed.

---

## Demo scenarios

Load any scenario from **Demo controls → Scenario**. Each sets a starting state only; what happens next comes from the real agent, policy engine and payments. **Simulate low balance** and the scenario buttons use the deterministic planner so they repeat reliably, and **Agent → New run** lets you choose the AI agent instead.

| Scenario | What happens |
|---|---|
| **A · Electricity running low** | About a day of units left: it finds the eligible vendors, pays 2 USDC through x402 and the meter is credited. |
| **B · Competing needs** | Electricity and data both low with 2 USDC left: it buys electricity, defers data and explains why. |
| **C · Over the limit** | Told to buy 5 USDC of electricity: refused before signing, naming every broken rule. |
| **D · Paid, not delivered** | Payment settles but the provider fails to release: recorded separately, then **Retry release** delivers with no second payment. |
| Electricity and data both low | 8 USDC left: two real payments, the more urgent one (data) first. |
| Electricity use tripled | Pays 0.30 USDC for a diagnostic. A stuck heater means minimal relief and a warning; guests staying means a purchase sized for the higher use (with approval above 2 USDC). Not urgent, or budget nearly gone: no diagnostic. |
| Unusual data usage | Flags it for review instead of buying more. |
| Budget exhausted, or authority revoked | Pays nothing and tells the owner why. |
| Purchase needs approval | Waits for the owner to approve the exact terms before a countdown ends. |
| Provider outage | Falls back to the other eligible provider. |
| Nothing urgent | Buys nothing and says why each utility can wait. |
| Empty payment wallet | Gets a real 402, then stops before signing: not charged. |
| Prompt injection | A provider's description tries to instruct the agent; the rules still decide. |

**Failure injection** (Demo controls) adds a provider that fails after payment, a provider that asks for more than it quoted (the agent refuses to sign) and provider outages. Resetting a scenario resets only the simulated household; testnet transactions are permanent.

## The agent and its tools

Each run executes in the background with an ordered, persisted event log that streams live to the run console, and the page replays it after a refresh. The **AI planner** (Gemini by default, or OpenAI) runs a tool-use loop with a step cap and timeouts, and shows its stated next steps and tool calls, never invented reasoning. The **deterministic planner** uses the same tools, rules and payments without a model.

The [tools](src/server/agent/runtime/tools.ts) all read real application state: `observe_household`, `inspect_utility`, `inspect_budget`, `discover_services`, `read_price_list`, `search_offers`, `compare_offers`, `get_allocation_recommendation`, `request_quote`, `evaluate_purchase` (a dry run of the rules), `buy_service`, `inspect_transaction`, `verify_fulfilment`, `reassess_household` and `finish`. Every argument is re-validated on the server, and code refuses a purchase when a utility still has plenty left or its usage looks abnormal.

## Spending policy and approvals

[`policy.ts`](src/server/household/policy.ts) runs eleven ordered checks on every payment, once when it is proposed and again with the live wallet balance just before signing:

0. Automatic purchasing is on.
1. The provider is approved and available.
2. The utility and network are allowed.
3. The recipient is the household's own meter or phone.
4. The quote is valid, unexpired and pays the registered wallet.
5. Per-purchase and per-utility caps.
6. The run's budget.
7. The daily budget.
8. The household budget and agent authority, including pending commitments.
9. The wallet holds enough USDC (read live; unreadable means refused).
10. Owner approval above the threshold.

The model is never told the limits; it learns them only when refused. A purchase that needs approval is parked unpaid, and the exact terms the owner sees (provider, product, naira and USDC amounts, payee, network, recipient) are fingerprinted, so if anything changes before approval the request closes unpaid. Approvals expire after the owner's window (3 minutes by default), and no tool can approve; only the owner can.

## Funding guard

x402's `exact` scheme pays from the agent's own balance, so Borderless adds an on-chain ceiling where it helps. The household treasury grants the agent wallet a capped, expiring USDC allowance through the Stellar Asset Contract (`approve`), and the agent tops itself up with `transfer_from` only when it is short. Stellar itself enforces the cap and expiry, so even a leaked agent key could never move more than its balance plus the remaining allowance. The owner can grant or revoke it in **Settings → Funding guard**, and `pnpm demo:funding-guard` proves it live.

## How Borderless decides

The [decision engine](src/server/agent/engine.ts) forecasts each utility from recent usage (hours left, urgency, unusual use and a confidence level), ranks needs by urgency and the owner's priorities, and compares every provider that can serve the account, aiming for 5 to 7 days of supply. It shares the budget so later needs can still be met, checks every option against the same policy used before signing, records each option it rejected and why, and explains its choice in plain sentences.

---

## Architecture

Borderless is a single Next.js 16 application with clearly separated internal modules. Providers are independent modules with their own receiving wallets and ledgers, reached through real HTTP requests, so an individual provider can later move to its own service or be replaced with a real one.

```text
src/
├── app/                      Landing, Overview, Agent (+ runs/[id]), Household, Accounts,
│   │                         Providers, Transactions, Settings
│   └── api/
│       ├── providers/        Registry, service documents, quotes, x402 purchases, retries
│       ├── services/         x402-protected information services (meter diagnostic)
│       ├── agent/runs/       Start and list runs, run logs, live events (SSE)
│       ├── purchases/        Approve, decline, recover, unpaid probe
│       └── funding-guard/    On-chain allowance status, grant, revoke
├── components/               Design system, devices, run console, approval cards, settings
└── server/
    ├── agent/                Engine, explanations; runtime/ (executor, planners, tools, run log)
    ├── payments/             x402 buyer, funding guard, wallet reads, Horizon confirmation
    ├── providers/            Six utility and two diagnostic providers, registry, x402 seller
    ├── household/            Spending policy, state, seed
    ├── transactions/         Purchases, approvals, sweep, events
    └── usage/  demo/  views/  db/
scripts/  tests/  tests/e2e/  drizzle/  docs/
```

| Area | Technology |
|---|---|
| Application and UI | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Database | SQLite locally and hosted libSQL (Turso) on Vercel, with Drizzle ORM |
| Payments | `@x402/core` and `@x402/stellar` 2.30, `@stellar/stellar-sdk` 17 |
| AI | Gemini or OpenAI through the OpenAI SDK, or a deterministic planner |
| Validation and tests | Zod 4, Vitest, Playwright with axe-core |

The [data model](src/server/db/schema.ts) keeps an append-only log of every agent run, the providers' binding quotes and the funding guard, and gives each purchase three separate statuses (its stage, its payment and its fulfilment), so a payment is never mistaken for a delivery.

---

## Proof that it works

Each capability below can be seen in the live demo or checked in the code and tests.

| What Borderless does | Where you can see it |
|---|---|
| Identifies a need from real household state | `need.identified` events from real forecasts; procurement decision tests |
| Discovers providers and tells free from paid | HTTP discovery of service documents, verified against the registry |
| Obtains a paid resource through a real x402 request | Live utility and diagnostic purchases on Stellar testnet |
| The provider answers 402 before releasing anything | **Request without paying**, and the stored 402 in inspection |
| Policy authorises or rejects independently | Eleven ordered checks before signing, recorded per purchase |
| A real testnet payment settles, then the resource is released | Facilitator settlement, Horizon confirmation, settle-then-fulfil handler |
| Uses what it bought, and can defer or refuse | Re-decides after a diagnostic; defers and refuses with reasons |
| Compares alternatives | Two providers per utility and two diagnostic offers, with rejected options recorded |
| Auditable and observable in real time | Separate payment and delivery records, receipts, live run stream and inspection |

Deployment, configuration, security, failure handling, troubleshooting and the rest of the detail are in the [technical reference](docs/technical-reference.md).

---

## Team

Built by **Gloria** and **Hannah**.
