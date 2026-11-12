/**
 * Live agent demo on Stellar TESTNET (requires `pnpm dev`).
 *
 *  1. Reset the demo household (electricity and data both running low).
 *  2. Borderless assesses, decides and pays — real x402 payments.
 *  3. Simulated time passes with data use jumping to 3× normal.
 *  4. Borderless re-assesses: flags the unusual usage instead of buying more data.
 *
 *   APP_BASE_URL=http://localhost:3001 pnpm demo:agent
 */
import "./_env";
import { eq } from "drizzle-orm";
import { runAgent, type AgentRunResult } from "../src/server/agent/run";
import { db } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import { runMigrations } from "../src/server/db/migrate";
import { DEMO_HOUSEHOLD_ID, seedDemoHousehold, wipeAll } from "../src/server/household/seed";
import { advanceTime, setUsageMultiplier } from "../src/server/usage/simulator";

const database = db();
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

function show(r: AgentRunResult) {
  console.log(`\n  ▸ ${r.explanation.headline}   [${r.decision.outcome}]`);
  for (const l of r.explanation.lines) console.log(`    ${l.kind.padEnd(11)} ${l.text}`);
  for (const p of r.purchases) {
    console.log(`    payment     ${p.purchaseId}: ${p.stage} · payment ${p.paymentStatus} · fulfilment ${p.fulfilmentStatus}`);
    if (p.explorerUrl) console.log(`                ${p.explorerUrl}`);
    if (p.failureCode) console.log(`                ${p.failureCode}: ${p.failureMessage}`);
  }
}

const balances = async () =>
  Object.fromEntries(
    (await database.select({ kind: s.utilityAccounts.kind, b: s.utilityBalances.balance, unit: s.utilityBalances.unit })
      .from(s.utilityBalances).innerJoin(s.utilityAccounts, eq(s.utilityAccounts.id, s.utilityBalances.accountId)))
      .map((r) => [r.kind, `${r.b} ${r.unit}`]),
  );

console.log("\nBorderless — live agent demo (Stellar TESTNET; simulated utilities)\n");
await runMigrations(database);
await wipeAll(database);
await seedDemoHousehold(database);
console.log("1. Demo household reset:", await balances());

console.log("\n2. Borderless assesses the household");
const first = await runAgent(database, DEMO_HOUSEHOLD_ID, { trigger: "scenario" });
show(first);
check("identified both shortages", first.decision.assessments.filter((a) => a.needsAction).length === 2);
check("every purchase completed with payment and fulfilment confirmed", first.purchases.length > 0 && first.purchases.every((p) => p.stage === "completed"));
check("stayed within budget", first.decision.budgetImpact.remainingAfterNgn >= 0);
console.log("   Devices now:", await balances());

console.log("\n3. Six simulated hours pass; data use jumps to 3× normal");
await setUsageMultiplier(database, DEMO_HOUSEHOLD_ID, "data", 3);
await database.update(s.utilityBalances).set({ balance: 400 }).where(eq(s.utilityBalances.accountId, "acc_demo_data")); // heavy use drained the bundle
await advanceTime(database, DEMO_HOUSEHOLD_ID, 6);
console.log("   Devices now:", await balances());

console.log("\n4. Borderless re-assesses");
const second = await runAgent(database, DEMO_HOUSEHOLD_ID, { trigger: "scenario" });
show(second);
check("flagged unusual data usage", second.decision.flags.some((f) => f.kind === "data"));
check("did not automatically buy more data", !second.decision.selected.some((p) => p.kind === "data") && second.purchases.length === 0);

const decisions = await database.select().from(s.agentDecisions);
const events = await database.select().from(s.activityEvents);
console.log(`\nAudit trail: ${decisions.length} decisions, ${events.length} timeline events persisted.`);
console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll live agent checks passed.\n");
process.exit(failures ? 1 : 0);
