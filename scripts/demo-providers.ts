/**
 * Live provider verification on Stellar TESTNET (requires `pnpm dev`).
 *
 *  A. Resets the demo household, then makes one real x402 purchase from EACH provider.
 *  B. Live failure cases with throwaway wallets — must fail BEFORE submission:
 *       - payer has a USDC trustline but no USDC     → insufficient_testnet_funds
 *       - payer has no USDC trustline at all          → trustline_missing
 *
 *   APP_BASE_URL=http://localhost:3001 pnpm demo:providers
 */
import "./_env";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { env } from "../src/server/config/env";
import { db } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import type { UtilityKind } from "../src/server/db/schema";
import { runMigrations } from "../src/server/db/migrate";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID, seedDemoHousehold, wipeAll } from "../src/server/household/seed";
import { formatAtomic } from "../src/server/payments/pricing";
import { executePurchase } from "../src/server/payments/x402-buyer";
import { createPurchase } from "../src/server/transactions/purchases";

const database = db();
const horizon = new Horizon.Server(env().STELLAR_HORIZON_URL);
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};
const usdcOf = async (pub: string) => {
  const acc = await horizon.loadAccount(pub);
  const line = acc.balances.find((b) => "asset_code" in b && b.asset_code === "USDC");
  return line ? Number(line.balance) : null;
};
const device = async (kind: UtilityKind) =>
  (await database.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, DEMO_ACCOUNTS[kind])))[0]!;

console.log("\nBorderless — live provider verification (Stellar TESTNET, simulated utilities)\n");
await runMigrations(database);
await wipeAll(database);
await seedDemoHousehold(database);
console.log("Demo household reset.\n");

// ── A. One real purchase per provider ───────────────────────────────────────
const cases: { kind: UtilityKind; amountNgn?: number; productCode?: string; expectAfter: number }[] = [
  { kind: "electricity", amountNgn: 3_000, expectAfter: 21.3 },
  { kind: "airtime", amountNgn: 500, expectAfter: 700 },
  { kind: "data", productCode: "data_1_5gb_30d", expectAfter: 1_686 },
];
const providerWallet: Record<UtilityKind, string> = {
  electricity: env().PROVIDER_ELECTRICITY_PAYTO!,
  airtime: env().PROVIDER_AIRTIME_PAYTO!,
  data: env().PROVIDER_DATA_PAYTO!,
};

console.log("A. Real purchases");
for (const c of cases) {
  const providerBefore = (await usdcOf(providerWallet[c.kind])) ?? 0;
  const t0 = Date.now();
  const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: c.kind, amountNgn: c.amountNgn, productCode: c.productCode, initiatedBy: "script" });
  const r = await executePurchase(database, p.id);
  const [pay] = await database.select().from(s.payments).where(eq(s.payments.purchaseId, p.id));
  const d = await device(c.kind);
  const providerAfter = (await usdcOf(providerWallet[c.kind])) ?? 0;
  const expectedUsdc = Number(formatAtomic(pay?.amountAtomic ?? "0"));
  console.log(`  ${c.kind.padEnd(11)} ${p.productCode.padEnd(15)} ₦${p.amountNgn.toLocaleString("en-NG").padStart(5)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`    tx ${r.txHash}\n    ${r.explorerUrl}`);
  check("completed with payment confirmed and fulfilment confirmed", r.stage === "completed" && r.paymentStatus === "confirmed" && r.fulfilmentStatus === "fulfilled", `${r.stage}/${r.paymentStatus}/${r.fulfilmentStatus}`);
  check("provider wallet received exactly the quoted testnet USDC", Number((providerAfter - providerBefore).toFixed(7)) === expectedUsdc, `+${(providerAfter - providerBefore).toFixed(7)} vs ${expectedUsdc}`);
  check("virtual device credited", d.balance === c.expectAfter, `${d.balance} ${d.unit}`);
  if (c.kind === "data") check("bundle activated with expiry", d.activeBundle === "1.5 GB · 30 days" && d.expiresAt !== null, `${d.activeBundle}, expires ${d.expiresAt?.toISOString()}`);
  if (c.kind === "electricity") check("demo token issued", /^\d{4}(-\d{4}){4}$/.test(String((r.receipt?.fulfilment as { demoToken?: string }).demoToken)));
}

// ── B. Live pre-submission failures with throwaway wallets ─────────────────
async function throwawayWallet(withTrustline: boolean): Promise<Keypair> {
  const kp = Keypair.random();
  const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`Friendbot failed: ${res.status}`);
  if (withTrustline) {
    const acc = await horizon.loadAccount(kp.publicKey());
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset: USDC }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    await horizon.submitTransaction(tx);
  }
  return kp;
}

async function runWithPayer(kp: Keypair, label: string, expectedCode: string) {
  const realSecret = process.env.AGENT_STELLAR_SECRET;
  process.env.AGENT_STELLAR_SECRET = kp.secret();
  try {
    const airtimeBefore = (await device("airtime")).balance;
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "airtime", amountNgn: 200, initiatedBy: "script" });
    const r = await executePurchase(database, p.id);
    const ops = await horizon.operations().forAccount(kp.publicKey()).limit(50).call();
    const types = ops.records.map((o) => o.type);
    console.log(`  ${label}`);
    check(`fails with ${expectedCode}`, r.failureCode === expectedCode, `${r.failureCode}: ${r.failureMessage}`);
    check("recorded as failed, not charged, nothing fulfilled", r.stage === "failed" && r.paymentStatus === "failed" && r.fulfilmentStatus === "not_started");
    check("no payment (invoke_host_function) on-chain for this wallet", !types.includes("invoke_host_function"), `operations: ${types.join(", ")}`);
    check("virtual phone unchanged", (await device("airtime")).balance === airtimeBefore);
  } finally {
    process.env.AGENT_STELLAR_SECRET = realSecret;
  }
}

console.log("\nB. Live failure cases (throwaway testnet wallets)");
await runWithPayer(await throwawayWallet(true), "payer with trustline but zero USDC", "insufficient_testnet_funds");
await runWithPayer(await throwawayWallet(false), "payer without a USDC trustline", "trustline_missing");

const agentUsdc = await usdcOf(env().AGENT_STELLAR_PUBLIC!);
console.log(`\nAgent wallet now holds ${agentUsdc} testnet USDC.`);
console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll live provider checks passed.\n");
process.exit(failures ? 1 : 0);
