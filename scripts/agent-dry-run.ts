/** Shows what the agent WOULD decide right now, without creating purchases or paying. */
import "./_env";
import { decide } from "../src/server/agent/engine";
import { explain } from "../src/server/agent/explain";
import { buildDecisionInput } from "../src/server/agent/run";
import { db } from "../src/server/db/client";
import { DEMO_HOUSEHOLD_ID } from "../src/server/household/seed";

const input = await buildDecisionInput(db(), DEMO_HOUSEHOLD_ID);
const d = decide(input);
const e = explain(d);
console.log(`\n${e.headline}   [outcome: ${d.outcome}]\n`);
for (const l of e.lines) console.log(`  ${l.kind.padEnd(11)} ${l.text}`);
console.log("\nSelected:", d.selected.map((p) => `${p.kind} ${p.product.label} (${p.basis}${p.requiresApproval ? ", needs approval" : ""})`).join("; ") || "none");
console.log("Budget:", d.budgetImpact, "\n");
