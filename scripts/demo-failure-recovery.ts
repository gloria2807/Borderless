/**
 * Live failure-path check (Stellar TESTNET):
 *  1. Replay: re-request a completed purchase without payment → provider returns stored receipt, no charge.
 *  2. Provider fails AFTER payment → payment confirmed, fulfilment failed, device unchanged.
 *  3. Recovery → utility released without a second payment (agent USDC unchanged by recovery).
 */
import "./_env";
import { desc, eq } from "drizzle-orm";
import { db } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import { setFault } from "../src/server/demo/faults";
import { DEMO_ACCOUNTS, DEMO_HOUSEHOLD_ID } from "../src/server/household/seed";
import { executePurchase, recoverPurchase } from "../src/server/payments/x402-buyer";
import { createPurchase } from "../src/server/transactions/purchases";
import { env } from "../src/server/config/env";

const database = db();
const base = env().APP_BASE_URL;
const agent = env().AGENT_STELLAR_PUBLIC!;
const usdc = async () => {
  const j = (await (await fetch(`${env().STELLAR_HORIZON_URL}/accounts/${agent}`)).json()) as { balances: { asset_code?: string; balance: string }[] };
  return j.balances.find((b) => b.asset_code === "USDC")!.balance;
};
const balance = async (accountId: string) => (await database.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, accountId)))[0]!.balance;
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

console.log("\n1. Idempotent replay of a completed purchase");
const [done] = await database.select().from(s.purchases).where(eq(s.purchases.stage, "completed")).orderBy(desc(s.purchases.createdAt)).limit(1);
if (!done) throw new Error("Run `pnpm demo:purchase` first");
const [acct] = await database.select().from(s.utilityAccounts).where(eq(s.utilityAccounts.id, done.accountId));
const before1 = await usdc();
const replay = await fetch(`${base}/api/providers/${done.kind}/purchase`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ purchaseId: done.id, accountIdentifier: acct!.identifier, ...(acct!.network ? { network: acct!.network } : {}), ...(done.kind === "data" ? { productCode: done.productCode } : { amountNgn: done.amountNgn }) }),
});
check("unpaid replay returns 200 with stored receipt (no 402)", replay.status === 200 && replay.headers.get("x-borderless-replay") === "true", `HTTP ${replay.status}`);
const again = await executePurchase(database, done.id);
check("executePurchase on a completed purchase is a no-op", again.stage === "completed");
check("agent USDC unchanged by replay", (await usdc()) === before1, `${before1} → ${await usdc()}`);

console.log("\n2. Provider fails after payment");
await setFault("provider_fulfilment_failure", true);
const before2 = await usdc();
const deviceBefore = await balance(DEMO_ACCOUNTS.airtime);
const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "airtime", amountNgn: 500, initiatedBy: "script" });
const r = await executePurchase(database, p.id);
await setFault("provider_fulfilment_failure", false);
const after2 = await usdc();
check("payment confirmed on-chain", r.paymentStatus === "confirmed", `${r.paymentStatus}, tx ${r.txHash?.slice(0, 12)}…`);
check("fulfilment marked failed, not merged into success", r.fulfilmentStatus === "failed" && r.stage === "needs_attention", `${r.stage}/${r.fulfilmentStatus}`);
check("virtual phone NOT credited", (await balance(DEMO_ACCOUNTS.airtime)) === deviceBefore);
check("exactly one payment left the wallet", Number((Number(before2) - Number(after2)).toFixed(7)) === 0.005, `${before2} → ${after2}`);

console.log("\n3. Recovery without re-payment");
const blocked = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "airtime", amountNgn: 500, initiatedBy: "script" }).then(() => false, (e) => e.code === "purchase_in_progress");
check("new airtime purchase blocked while one needs attention", blocked);
const rec = await recoverPurchase(database, p.id);
check("recovered to completed", rec.stage === "completed" && rec.fulfilmentStatus === "fulfilled", `${rec.stage}/${rec.fulfilmentStatus}`);
check("virtual phone credited exactly once", (await balance(DEMO_ACCOUNTS.airtime)) === deviceBefore + 500, `${deviceBefore} → ${await balance(DEMO_ACCOUNTS.airtime)}`);
check("no second payment during recovery", (await usdc()) === after2);
const rec2 = await recoverPurchase(database, p.id);
check("second recovery is a no-op", rec2.stage === "completed" && (await balance(DEMO_ACCOUNTS.airtime)) === deviceBefore + 500);

console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll live checks passed.\n");
process.exit(failures ? 1 : 0);
