/**
 * Runs ONE real x402 purchase on Stellar testnet against the running app.
 *
 *   pnpm demo:purchase                      # ₦3,000 electricity
 *   pnpm demo:purchase --kind airtime --amount 500
 *   pnpm demo:purchase --kind data --product data_1_5gb_30d
 *
 * Requires `pnpm dev` to be running (providers are HTTP endpoints of the app).
 */
import "./_env";
import { eq } from "drizzle-orm";
import { db } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import type { UtilityKind } from "../src/server/db/schema";
import { DEMO_HOUSEHOLD_ID } from "../src/server/household/seed";
import { formatAtomic } from "../src/server/payments/pricing";
import { executePurchase } from "../src/server/payments/x402-buyer";
import { createPurchase } from "../src/server/transactions/purchases";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const kind = (arg("kind") ?? "electricity") as UtilityKind;
const amountNgn = arg("amount") ? Number(arg("amount")) : kind === "data" ? undefined : 3_000;
const productCode = arg("product") ?? (kind === "data" ? "data_1_5gb_30d" : undefined);

const database = db();
const started = Date.now();
console.log(`\nBorderless payment proof — ${kind} (Stellar TESTNET; simulated utility)\n`);

const purchase = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind, amountNgn, productCode, initiatedBy: "script" });
console.log(`purchase   ${purchase.id}  ${purchase.productCode}  ₦${purchase.amountNgn.toLocaleString("en-NG")}  stage=${purchase.stage}`);
if (purchase.stage !== "requested") {
  console.log("Purchase needs owner approval before it can be paid. Stopping.");
  process.exit(0);
}

const result = await executePurchase(database, purchase.id);
const [payment] = await database.select().from(s.payments).where(eq(s.payments.purchaseId, purchase.id));
const events = await database.select().from(s.activityEvents).where(eq(s.activityEvents.purchaseId, purchase.id)).orderBy(s.activityEvents.createdAt);

console.log("\nTimeline");
for (const e of events) console.log(`  [${e.severity.padEnd(8)}] ${e.title}${e.detail ? ` — ${e.detail}` : ""}`);

console.log("\nResult");
console.log(`  stage              ${result.stage}`);
console.log(`  payment status     ${result.paymentStatus}`);
console.log(`  fulfilment status  ${result.fulfilmentStatus}`);
if (payment?.amountAtomic) console.log(`  paid               ${formatAtomic(payment.amountAtomic)} testnet USDC (demo pricing)`);
if (result.txHash) console.log(`  tx hash            ${result.txHash}\n  explorer           ${result.explorerUrl}`);
if (payment?.ledger) console.log(`  ledger             ${payment.ledger}`);
if (result.receipt?.fulfilment.status === "fulfilled") {
  const f = result.receipt.fulfilment;
  console.log(`  device             ${f.balanceBefore} → ${f.balanceAfter} ${f.unit}${f.demoToken ? `   demo token ${f.demoToken}` : ""}`);
}
if (result.failureCode) console.log(`  failure            ${result.failureCode}: ${result.failureMessage}`);
console.log(`  elapsed            ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
process.exit(result.stage === "completed" ? 0 : 1);
