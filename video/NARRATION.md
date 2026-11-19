# Borderless demo video — narration kit

The video (`video/out/borderless-demo.mp4`, 4:24) already has the picture, captions, music and sound design. It needs one thing only real people can give it: **Gloria's and Hannah's voices**. No synthetic voice was used.

## How to record (about 30 minutes)

1. **Room:** quiet, soft furnishings, phone on silent. Use a headset mic or a phone voice recorder about a fist's distance from your mouth.
2. **Watch and speak:** play `borderless-demo.mp4` with headphones on and read each caption as it appears. The captions are timed for a relaxed, brisk pace (about 180 words a minute). Natural Nigerian delivery is exactly right; don't flatten it.
3. **Recording:** record each scene as its own take: `s1.wav`, `s2.wav`, and so on. Start each take with one second of silence, then begin speaking at the scene's start time below.
   - **If a take runs long:** say less rather than rushing. Keep the meaning, and drop words if you need to.
   - **Wording:** say it as you'd say it to a friend. Small wording changes are fine. Just don't claim anything the screen doesn't show.
4. **Mixing:** drop the files into `video/out/`. Then, from the repository root, run:
   ```bash
   node video/mux.mjs voice video/out/s1.wav@0 video/out/s2.wav@38 video/out/s3.wav@68 video/out/s4.wav@90 video/out/s5.wav@126 video/out/s6.wav@176 video/out/s7.wav@218 video/out/s8.wav@238
   ```
   - The music ducks automatically under your voice, and the voice is levelled to −16 LUFS.
   - The result is `video/out/borderless-demo-final.mp4`.
   - If your timing needs a nudge, change the `@seconds` value for that scene. For example, `s4.wav@91` starts Scene 4 one second later.

A single continuous recording works too: `node video/mux.mjs voice video/out/narration.wav`.

## Suggested speakers

| Scene | Starts at | Speaker | What's on screen |
| --- | --- | --- | --- |
| 1 · The shared experience | 0:00 | Gloria | Lights out, empty meter, data text |
| 2 · The insight | 0:38 | Hannah | Overview, then competing needs → one budget |
| 3 · Introducing Borderless | 1:08 | Gloria | Logo, Settings (USDC limits), Overview |
| 4 · The decision (2 USDC) | 1:30 | Hannah | Scenario B, live |
| 5 · Architecture | 2:06 | Gloria | Six-layer diagram |
| 6 · Live purchase | 2:56 | Hannah | Scenario A, live, plus the explorer |
| 7 · Trust | 3:38 | Gloria | Scenario C, refused before signing |
| 8 · The bigger possibility | 3:58 | Both, closing together | Overview, then the final card |

## The script, as timed in the video

Times are when each line appears on screen.

**Scene 1 (0:00)**
- 0:01.6 We've all been here before. *(shown as the title; still say it)*
- 0:05.2 You're in the middle of something important.
- 0:08.0 Maybe you're working, on a call, or finally getting a chance to relax.
- 0:13.6 Then NEPA takes the light. *(the screen goes dark at 0:13.5)*
- 0:15.8 You check the meter. They didn't take it o — it was your units that finished.
- 0:20.8 Now you're checking your account balance, figuring out how much to buy to reload your meter.
- 0:26.8 And just when you think you're done, MTN sends you a message: your data is down to 50MB too.
- 0:32.8 So now you're deciding what you need to pay for between the two.

**Scene 2 (0:38)**
- 0:38.4 We realised the problem isn't simply forgetting to recharge.
- 0:41.6 It's the constant responsibility of monitoring different services, anticipating shortages, deciding what deserves attention and manually making purchases.
- 0:51.0 When money is limited, it brings pressure, frustration and exhaustion. These are competing household needs.
- 0:56.6 Now, why not automate everything? Automatic payments can follow instructions, but they don't know which need matters more right now.
- 1:05.6 We thought there had to be a better way.

**Scene 3 (1:08)**
- 1:08.6 So we built Borderless. An autonomous household utilities agent.
- 1:13.6 You set your household budget, priorities and spending permissions.
- 1:17.0 Borderless monitors your utilities, predicts shortages, discovers eligible services, evaluates options, and makes purchases within the authority you've given it.
- 1:26.8 You set the rules. Borderless does the work.

**Scene 4 (1:30)**
- 1:30.4 But here's where Borderless differs from ordinary auto-pay.
- 1:33.8 Imagine you have just 2 USDC of spending authority left. Your electricity is running low. Your mobile data is running low too.
- 1:41.6 Both matter. But you can't afford both right now. What should happen?
- 1:46.6 Borderless weighs the household's priorities, urgency and eligible options. It prioritises electricity and defers the data purchase. And it explains why.
- 1:55.6 That's the difference. Borderless isn't simply responding to a low balance.
- 2:00.6 It's making a purchasing decision across competing needs, within rules you've approved.

**Scene 5 (2:06)**
- 2:06.4 Here's how we've engineered it.
- 2:08.6 First, the household owner: budget, priorities and spending permissions.
- 2:12.6 The agent observes, forecasts shortages, discovers eligible providers and evaluates what should be purchased.
- 2:19.6 But one decision matters most: the agent does not control financial authority.
- 2:23.2 Every intended purchase passes through an independent policy engine. It checks the provider, payment terms, limits, balance and whether approval is needed.
- 2:31.2 Only then can the purchase reach the x402 payment layer.
- 2:34.2 The provider protects the resource behind HTTP 402. Borderless validates the terms; the facilitator verifies and settles on Stellar.
- 2:41.8 Only after settlement does the provider release the resource.
- 2:45.2 Finally, Borderless verifies fulfilment and records the whole lifecycle.

**Scene 6 (2:56)**
- 2:56.4 Let's see Borderless execute a purchase. We simulate a low electricity balance.
- 3:01.2 Borderless detects the shortage, checks its spending authority and discovers an eligible electricity provider.
- 3:07.8 It requests the purchase. The provider responds: HTTP 402, Payment Required.
- 3:12.6 It won't release the protected resource until payment is verified.
- 3:16.8 Borderless validates the terms against the household's permissions. It's within the authorised limit, so it proceeds.
- 3:22.6 Using x402 on Stellar, it makes a real USDC payment on testnet.
- 3:26.8 The provider verifies the settlement and releases the purchase.
- 3:30.0 The simulated meter is credited. Borderless verifies fulfilment and generates a receipt.

**Scene 7 (3:38)**
- 3:38.4 Of course, giving an agent the ability to spend means giving it boundaries.
- 3:42.0 Borderless has an independent policy engine. The agent cannot increase its own spending authority.
- 3:47.6 Here, it attempts a purchase above the authorised limit. The system rejects it before payment is signed.
- 3:53.8 Because autonomy should never mean losing control.

**Scene 8 (3:58)**
- 3:58.4 We started with a problem most of us have experienced.
- 4:01.6 But the bigger opportunity is how households reach essential services.
- 4:05.8 Instead of watching balances and paying one by one, households can delegate to an agent they control.
- 4:10.8 We started with electricity. The same system extends to airtime, data and more.
- 4:14.8 This is Borderless.
- 4:16.8 Your household stays powered and connected. Borderless handles the rest.

## What's real in the video

- **All Borderless footage is the real application:** recorded click by click with `video/record.mjs`, nothing staged or animated over. The window shows the product address; the footage was recorded from the same build running locally.
- **Scenario A's payment is real.**
  - Transaction `46846b41a6735355b153f0213a84d3e86655cb355f0a40376ca25672da232c73`, on Stellar testnet, ledger 5,780,559.
  - It moved 2.0000000 test USDC from the agent wallet to the provider's registered payee.
  - I verified it on Horizon and on Stellar Expert, and the explorer view in the video is a recording of that page.
- **Scenario B** also settled for real, from its own run in the recording.
- **Scenario C** was refused by the policy engine before signing. Nothing was paid.
- **What's simulated:** the provider, the meter and the electricity are simulated. The video labels this on screen.
- **Speed changes are labelled:**
  - The first second of the live run is slowed to 0.16× to show each step, and the badge says so.
  - The settlement wait is shortened, and also labelled.
- **Opening scene:** these are drawn illustrations of the problem, not app screens.
- **Architecture:** the diagram reflects the code. The file paths shown are real files in the repository. The recording uses the deterministic planner, and the diagram says so.
