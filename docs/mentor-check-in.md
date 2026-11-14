# Borderless — two-minute mentor check-in

About 300 words: two minutes at a natural pace. Bold lines are cues for the screen, not words to say.

---

## Script

**Opening.** In a lot of Nigerian homes, the lights go off at 9pm because nobody noticed the meter was low. The data runs out halfway through a call. And when money's tight, someone still has to decide what gets topped up first, and then go and pay for each one.

**Product.** Borderless is an autonomous household utilities agent. The owner sets a budget and spending rules once. From then on, Borderless watches electricity, airtime and data, predicts when each will run out, finds providers that can actually serve the household, decides what to buy, pays, and checks that the units arrived.

**Differentiation.** Bank auto-pay tops up a fixed amount when a trigger fires. It can't choose. Borderless decides how to share limited money across competing needs. **Show Scenario B.** There's 2 USDC of spending authority left, and both electricity and data are low. Borderless puts it into electricity because that's the owner's first priority. It defers data, and it explains what it saw, what each option costs and what's left afterwards. Change the priorities and the decision changes with them.

**Demonstration.** **Press Simulate low balance.** The meter drops to about a day of units. The agent notices, checks its authority, finds the vendors authorised for this meter's distribution company, and asks for 2 USDC of electricity. The provider answers HTTP 402 with its payment terms. The wallet's rules approve it, the payment settles on Stellar testnet, the provider verifies the settlement, and only then does the meter go up.

**Technical significance.** x402 is the gate. Without payment the provider releases nothing. **Press Request without paying** and you see the 402.

**Trust.** The AI never holds the authority to spend. Code enforces 2 USDC automatic, 4 per task, 10 per day, and approval above 2. **Show Scenario C.** I tell it to buy 5 USDC and the wallet refuses before anything is signed.

**Vision.** It's electricity today. The same agent and wallet already handle airtime and data, and the next step is any household service sold per request.

---

## Demo operator checklist

### Before the session (10 minutes)

1. `pnpm wallets:status` → the agent wallet holds **at least 8 test USDC** (each live purchase uses about 2).
   - If it's low, run `pnpm wallets:recycle` (returns what demo providers received).
   - If it's still low, use the Circle testnet faucet (see README, "Testnet setup").
2. `pnpm dev`, then open `http://localhost:3000/overview`.
3. In the Overview, press **Reset demo**. The household is now Scenario A: everything healthy and the agent wallet balance visible.
4. Settings → confirm Borderless is **Active**, automatic up to **2.00 USDC**, largest request **4.00**, task **4.00**, day **10.00**.
5. Do one rehearsal: **Simulate low balance** should end with **Payment confirmed** and **Utility released**. Then press **Reset demo** again.
6. Keep a second tab on Stellar Expert (testnet) to show a transaction.

### During the demo

| Moment | Action | What the audience sees |
| --- | --- | --- |
| Scenario B (decisions) | Demo controls → load **B · Competing needs: 2 USDC left** → Agent → Start run (deterministic) | Electricity bought, data deferred, eight-point explanation |
| Scenario A (main) | **Reset demo** → **Simulate low balance** | Live console: discover → 402 → policy → sign → settle → release → meter up |
| Proof | Transaction → **Inspect procurement** → **Request without paying** | The provider's real HTTP 402 |
| Scenario C (trust) | Demo controls → load **C · Spending limit rejection** → **Attempt over-limit purchase** | "Refused before anything was signed", with the failing rules |
| Optional D | Load **D · Paid, but the provider fails to deliver** → run → **Retry release** | Payment confirmed / Release failed, then released with the same tx hash |

### If something goes wrong

- **Facilitator or testnet unavailable:** the run shows the honest failure ("Not charged"). Say so; use Scenario C, which needs no network, and show an earlier settled transaction on Stellar Expert.
- **"Borderless is paused":** Settings → **Resume Borderless**.
- **AI quota exhausted:** live runs use the deterministic planner by default; nothing changes.
- **Wallet too low mid-demo:** `pnpm wallets:recycle` takes about 20 seconds.
