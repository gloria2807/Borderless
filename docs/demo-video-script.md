# Borderless — demo video script

About **8 minutes**. Ten scenes, each one short and self-contained, so you can record them separately and cut them together.
**Do** = what to click. **Say** = narration. **Show** = what should be on screen before you move on.

Live purchases spend test USDC from the agent wallet: about 2 USDC each. The full script uses roughly 8 USDC.

---

## Before recording (off camera, 10 minutes)

1. Check the agent wallet holds **at least 10 test USDC** with `pnpm wallets:status`.
   - If it doesn't, run `pnpm wallets:recycle`.
   - If it's still short, use the Circle faucet (README, "Testnet setup").
2. Start the app with `pnpm dev`. Use a 1440-wide browser window at 100% zoom.
3. Open `http://localhost:3000/settings` and check that:
   - Borderless is **Active**;
   - automatic purchases are **2.00** and the largest request is **4.00**;
   - each task is **4.00** and each day is **10.00**.
4. Do one rehearsal of Scene 3, then press **Reset demo** on the Overview.
5. Open a second browser tab on `https://stellar.expert/explorer/testnet`.
6. Use **Deterministic (no AI)** for every run: it is repeatable and doesn't depend on the model quota.

**How to load a scenario:** open **Demo controls** (bottom of the sidebar), pick the scenario, press **Load scenario**, then confirm.
**How to start a run:** go to **Agent**, open **New run**, select **Deterministic (no AI)**, then press **Start run**.

---

## Scene 1 — The problem and the product (30 s)

**Do:** Open `http://localhost:3000/`. Scroll slowly through the hero, *How a purchase works*, *Why payment matters* and *What's real, what's simulated*.

**Say:** "Prepaid electricity, airtime and data run out when you least expect it, and when money's tight someone has to decide what gets topped up first. Borderless is an autonomous agent that does this for the household. It watches the meter and the phone line, decides what's worth buying within the owner's rules, and pays providers itself, over x402 on Stellar testnet."

**Show:** the x402 *Response shape* panel, and the *Real / Simulated* section, so viewers know what's genuine.

---

## Scene 2 — The household and its owner (40 s)

**Do:** Press **Open the demo**. On the Overview, point at:
- the sidebar ("Okafor Household · Adaeze Okafor, owner");
- the headline figures;
- the **Electricity** card;
- the **Spending authority** panel.

**Say:** "This is the Okafor household. Adaeze, the owner, has given Borderless limited authority: up to 2 USDC per purchase automatically, anything bigger needs her approval, never more than 4 in one go or one task, and 10 a day. On top of that, it can never spend more than its wallet actually holds; that balance is read live from Stellar testnet."

**Show:** "Spendable now, automatically: 2.00 USDC" and the live agent-wallet balance.

---

## Scene 3 — Scenario A: the main electricity purchase (2 min) ⭐

**Do:** Press **Simulate low balance**. The page jumps to the live run.

**Say (as the stages light up):** "I've just dropped the meter to about a day of power. That's real: it's saved on the server. Borderless notices, forecasts when it'll run out and finds the vendors authorised for this meter's distribution company. It compares offers and picks 2 USDC of electricity, within its automatic limit."

**Say (when *Requesting (HTTP 402)* and *Paying* light up):** "Now it asks the provider for the electricity. The provider answers HTTP 402, Payment Required, with its terms. The wallet's rules check that request independently, then it signs, and the payment settles on Stellar testnet. Only after the provider has verified that settlement does it release the units."

**Do:**
1. When the run finishes, point at the green summary and the purchase row: **Payment confirmed** and **Utility released**.
2. Click the transaction hash; it opens in Stellar Expert.

**Say:** "Here's the real transaction on Stellar: 2 USDC from the agent wallet to the provider's registered wallet."

**Do:** Back in the app:
1. Click **Inspect procurement** on the purchase.
2. Scroll the steps.
3. Press **Request without paying**.

**Say:** "Every step is recorded: the provider, its published terms, the 402, the policy checks, the transaction and what was released. And if we ask without paying, the provider refuses with a 402. No payment, no electricity."

**Do:** Go to **Household** and show the credited meter and demo token.

---

## Scene 4 — Scenario B: competing needs with 2 USDC left (1 min 15 s) ⭐

**Do:** Load **B · Competing needs: 2 USDC left**, then start a deterministic run.

**Say:** "This is why Borderless isn't bank auto-pay. Electricity and data are both running out, but only 2 USDC of the budget is left. Auto-pay would just top up whatever triggered. Borderless has to choose."

**Do:** When it finishes, read the summary banner, or expand the *Decision* step.

**Say:** "It saw both needs, checked Adaeze's priorities (electricity first), compared what each option costs, bought 2 USDC of electricity and deferred data. It tells her exactly what's left, and what she could change if she wants both."

**Optional (one more payment of about 1.80 USDC):**
1. Reload the scenario. Loading it puts electricity first again.
2. Go to **Settings**, move **Mobile data** above **Electricity** and save.
3. Start a deterministic run.

**Say:** "Same household, same money, different priorities: this time the 2 USDC goes to data, and electricity waits. The decision comes from the rules, not a script."

---

## Scene 5 — Scenario C: the wallet says no (45 s) ⭐

**Do:** Load **C · Spending limit rejection**. In **Demo controls**, press **Attempt over-limit purchase**.

**Say:** "Now I'm telling the agent to buy 5 USDC of electricity, more than Adaeze allows in a single purchase. The agent tries, using its normal tools. But the AI never holds the authority to spend: the wallet's rules are code."

**Show:** the summary saying "refused the purchase before anything was signed". The amount is above the 4 USDC per-purchase maximum and the task budget, and every payment stage stays unlit.

**Say:** "Refused before signing. Nothing was paid, and nothing even reached the provider."

---

## Scene 6 — Asking the owner first (45 s)

**Do:** Load **Purchase needs approval**, then start a deterministic run.

**Say:** "Here the purchase is above Adaeze's automatic limit, so Borderless stops and asks."

**Show:** the approval card. It has the amount in USDC, the reason, the budget after, a live countdown and the exact terms it would pay.

**Do:** Press **Decline**. This saves funds; to show a payment instead, press **Approve and pay**.

**Say:** "The approval is tied to these exact terms. If anything changes, or the clock runs out, it lapses unpaid. The agent can never approve its own request."

---

## Scene 7 — Scenario D: paid, but not delivered (1 min)

**Do:** Load **D · Paid, but the provider fails to deliver**, then start a deterministic run.

**Say:** "What if the provider takes the money and doesn't deliver?"

**Show:** the purchase marked **Payment confirmed** and **Release failed**, recorded separately, with an amber summary that says so.

**Do:**
1. In **Demo controls → Failure injection**, switch off *Provider fails to release…*.
2. Open the purchase from **Transactions**.
3. Press **Retry release** and confirm.

**Say:** "Borderless never pretends it worked, and never pays twice. Retrying releases the units against the same transaction. Same hash, one payment."

---

## Scene 8 — Optional: buying information first (1 min)

**Do:** Load **Electricity use has tripled — stuck heater**, then start a deterministic run.

**Say:** "Electricity use has tripled and Borderless can't see why from hourly totals. A 0.30 USDC meter diagnostic could change what it buys, so it pays for that first, over x402. The report says a water heater is stuck on. So instead of a big top-up, it buys only minimal relief and tells Adaeze to fix the heater."

---

## Scene 9 — The owner stays in control (30 s)

**Do:** Go to **Settings** and press **Pause Borderless**. Back on the Overview, show **Simulate low balance** disabled and the "Paused by you" status. Then press **Resume Borderless**.

**Say:** "Adaeze can pause Borderless at any time. A task in progress stops at its next step. There's also an emergency stop that pauses it, revokes spending and declines anything waiting for approval."

---

## Scene 10 — Close (15 s)

**Do:** Return to the Overview.

**Say:** "Borderless keeps the household powered and connected. It decides what's worth buying, pays per request over x402 on Stellar, and stays inside rules the owner controls. Electricity today; airtime and data already work the same way."

---

## If something goes wrong while recording

- **A run says "Not charged"** (the facilitator or testnet was unavailable): this is the honest failure, so keep it or re-record. Recorded settlements remain on Stellar Expert.
- **"Borderless is paused":** Settings → **Resume Borderless**. If automatic purchasing is off after an emergency stop, turn it back on.
- **"A run is already in progress":** wait for it to finish, or open it from **Agent → Recent runs**.
- **Wallet running low:** `pnpm wallets:recycle` (about 20 seconds).
- **Between takes:** **Reset demo** restores Scenario A. Testnet transactions already made stay on Stellar.
