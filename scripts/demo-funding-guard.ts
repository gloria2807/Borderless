/**
 * Live Funding guard verification on Stellar TESTNET (requires `pnpm dev`).
 *
 * Uses a fresh, EMPTY agent wallet so every payment must be funded through the on-chain
 * allowance the household treasury grants it:
 *
 *  1. Treasury grants the empty wallet a 0.05 test USDC allowance (USDC SAC `approve`).
 *  2. A real x402 purchase: the wallet is short, so Borderless draws from the treasury
 *     (`transfer_from`), then pays the provider. The draw is capped by the allowance.
 *  3. A further draw beyond the allowance is refused BY STELLAR at simulation.
 *  4. The owner revokes (approve 0); a draw is refused by Stellar again.
 *  5. A purchase the wallet can't cover now fails before signing — nothing charged.
 *
 *   APP_BASE_URL=http://localhost:3000 pnpm demo:funding-guard
 */
import "./_env";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { env, resetEnvCache } from "../src/server/config/env";
import { db } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import { runMigrations } from "../src/server/db/migrate";
import { DEMO_HOUSEHOLD_ID, resetDemo } from "../src/server/household/seed";
import { drawFromTreasury, FundingGuardError, grantAllowance, readAllowanceAtomic, revokeAllowance } from "../src/server/payments/funding-guard";
import { formatAtomic } from "../src/server/payments/pricing";
import { executePurchase } from "../src/server/payments/x402-buyer";
import { createPurchase } from "../src/server/transactions/purchases";

const database = db();
const horizon = new Horizon.Server(env().STELLAR_HORIZON_URL);
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const EXPLORER = env().STELLAR_EXPLORER_TX_URL.replace(/\/+$/, "");
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};
const usdcOf = async (pub: string) => {
  const acc = await horizon.loadAccount(pub);
  const line = acc.balances.find((b) => "asset_code" in b && b.asset_code === "USDC");
  return line ? Number(line.balance) : 0;
};

const treasury = process.env.TREASURY_STELLAR_PUBLIC;
if (!treasury || !process.env.TREASURY_STELLAR_SECRET) {
  console.error("TREASURY_STELLAR_SECRET is not set. Run `pnpm wallets:setup` first.");
  process.exit(1);
}

console.log("\nBorderless — live Funding guard verification (Stellar TESTNET, test USDC only)\n");
await runMigrations(database);
await resetDemo(database, "both-low");

// A fresh, empty agent wallet (XLM for fees + USDC trustline, 0 USDC).
const float = Keypair.random();
process.stdout.write("  Creating an empty agent wallet (Friendbot + USDC trustline)… ");
const fb = await fetch(`https://friendbot.stellar.org/?addr=${float.publicKey()}`);
if (!fb.ok) throw new Error(`Friendbot failed: ${fb.status}`);
const acc = await horizon.loadAccount(float.publicKey());
const trust = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).addOperation(Operation.changeTrust({ asset: USDC })).setTimeout(60).build();
trust.sign(float);
await horizon.submitTransaction(trust);
console.log(float.publicKey());

const realSecret = process.env.AGENT_STELLAR_SECRET;
const realPublic = process.env.AGENT_STELLAR_PUBLIC;
process.env.AGENT_STELLAR_SECRET = float.secret();
process.env.AGENT_STELLAR_PUBLIC = float.publicKey();
resetEnvCache();

try {
  const treasuryBefore = await usdcOf(treasury);

  console.log("\n1. Treasury grants the agent wallet a 0.05 test USDC allowance (1 day)");
  const grant = await grantAllowance(database, DEMO_HOUSEHOLD_ID, 500_000n, 1);
  console.log(`    approve tx ${grant.txHash}\n    ${EXPLORER}/${grant.txHash}`);
  const allowance1 = await readAllowanceAtomic(treasury, float.publicKey());
  check("allowance read back on-chain is 0.05 USDC", allowance1 === 500_000n, `${formatAtomic(allowance1)} USDC, expires ledger ${grant.expirationLedger}`);

  console.log("\n2. Real x402 purchase from an empty wallet (₦3,000 electricity = 0.03 test USDC)");
  const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", providerId: "prv_demo_electricity", amountNgn: 3_000, initiatedBy: "script" });
  const r = await executePurchase(database, p.id);
  const [topUp] = await database.select().from(s.activityEvents).where(eq(s.activityEvents.type, "funding.topped_up"));
  const draw = topUp?.data as { amountAtomic?: string; txHash?: string } | undefined;
  console.log(`    top-up tx ${draw?.txHash}\n    payment tx ${r.txHash}\n    ${r.explorerUrl}`);
  check("purchase completed: paid and fulfilled", r.stage === "completed" && r.paymentStatus === "confirmed" && r.fulfilmentStatus === "fulfilled", `${r.stage}/${r.paymentStatus}/${r.fulfilmentStatus}`);
  check("top-up was drawn from the treasury, capped at the allowance", draw?.amountAtomic === "500000", `${formatAtomic(draw?.amountAtomic ?? "0")} USDC`);
  const allowance2 = await readAllowanceAtomic(treasury, float.publicKey());
  check("allowance is now used up on-chain", allowance2 === 0n, `${formatAtomic(allowance2)} USDC left`);
  check("agent wallet holds the top-up minus the payment", Math.abs((await usdcOf(float.publicKey())) - 0.02) < 1e-7, `${await usdcOf(float.publicKey())} USDC`);
  check("treasury paid out exactly the draw", Math.abs(treasuryBefore - (await usdcOf(treasury)) - 0.05) < 1e-7);

  console.log("\n3. Drawing more than the allowance");
  try {
    await drawFromTreasury(100_000n);
    check("Stellar refuses a draw beyond the allowance", false, "the draw went through");
  } catch (err) {
    check("Stellar refuses a draw beyond the allowance", err instanceof FundingGuardError && err.code === "allowance_exceeded", (err as Error).message);
  }

  console.log("\n4. Owner re-grants, then revokes");
  await grantAllowance(database, DEMO_HOUSEHOLD_ID, 500_000n, 1);
  const revoke = await revokeAllowance(database, DEMO_HOUSEHOLD_ID);
  console.log(`    revoke tx ${revoke.txHash}\n    ${EXPLORER}/${revoke.txHash}`);
  check("allowance is 0 after revocation", (await readAllowanceAtomic(treasury, float.publicKey())) === 0n);
  try {
    await drawFromTreasury(10_000n);
    check("Stellar refuses a draw after revocation", false, "the draw went through");
  } catch (err) {
    check("Stellar refuses a draw after revocation", err instanceof FundingGuardError && err.code === "allowance_exceeded", (err as Error).message);
  }

  console.log("\n5. A purchase the wallet can no longer cover (₦2,500 airtime = 0.025 test USDC; it holds 0.02)");
  const before = await usdcOf(float.publicKey());
  const p2 = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "airtime", providerId: "prv_demo_airtime", amountNgn: 2_500, initiatedBy: "script" });
  const r2 = await executePurchase(database, p2.id);
  check("fails before signing: not charged", r2.stage === "failed" && r2.paymentStatus === "failed" && r2.failureCode === "insufficient_testnet_funds", `${r2.failureCode}: ${r2.failureMessage}`);
  check("agent wallet unchanged", (await usdcOf(float.publicKey())) === before);
} finally {
  process.env.AGENT_STELLAR_SECRET = realSecret;
  process.env.AGENT_STELLAR_PUBLIC = realPublic;
  resetEnvCache();
  // The guard record now describes the throwaway wallet; clear it so the app shows the real one.
  await database.delete(s.fundingGuards).where(eq(s.fundingGuards.householdId, DEMO_HOUSEHOLD_ID));
}

console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll Funding guard checks passed.\n");
process.exit(failures ? 1 : 0);
