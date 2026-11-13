/**
 * Run the Borderless agent from the command line and watch every recorded event.
 * Purchases are REAL x402 payments on Stellar testnet, so the app must be running
 * (providers are its HTTP endpoints).
 *
 *   APP_BASE_URL=http://localhost:3001 pnpm agent:run
 *   APP_BASE_URL=http://localhost:3001 pnpm agent:run --scenario budget-covers-one
 *   APP_BASE_URL=http://localhost:3001 pnpm agent:run --mode deterministic "custom task text"
 */
import "./_env";
import { startAgentRun } from "../src/server/agent/runtime/executor";
import { runBus, type RunEventRow } from "../src/server/agent/runtime/run-log";
import { db, rawClient } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import { resetDemo } from "../src/server/household/seed";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const scenario = flag("scenario");
const mode = flag("mode") as "ai" | "deterministic" | undefined;
const task = args.join(" ").trim() || undefined;

const database = db();
await runMigrations(database);
if (scenario) {
  const s = await resetDemo(database, scenario);
  console.log(`Scenario loaded: ${s.name}\n  ${s.summary}\n`);
}

const short = (v: unknown, n = 160) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t && t.length > n ? `${t.slice(0, n)}…` : t;
};
const print = (e: RunEventRow) => {
  const head = `${String(e.seq).padStart(3)} ${e.stage.padEnd(20)} ${e.type}${e.tool ? ` ${e.tool}` : ""}${e.utility ? ` [${e.utility}]` : ""}`;
  const bits = [
    e.decision && `decision=${e.decision}`,
    e.paymentStatus && `payment=${e.paymentStatus}`,
    e.txHash && `tx=${e.txHash}`,
    e.error && `error=${e.error}`,
  ].filter(Boolean);
  console.log(head + (bits.length ? `  ${bits.join(" ")}` : ""));
  if (e.reason) console.log(`      ${short(e.reason, 300)}`);
  if (e.type === "tool.called" && e.input && Object.keys(e.input as object).length) console.log(`      args ${short(e.input)}`);
  if (e.type === "tool.result" && e.result) console.log(`      → ${short(e.result, 220)}`);
};

const { runId, done } = await startAgentRun(database, { householdId: "hh_demo", task, mode, trigger: "manual" });
console.log(`Run ${runId} started (${mode ?? "auto"} mode)\n`);
runBus.on(`run:${runId}`, print);
const outcome = await done;
console.log(`\n${outcome.status.toUpperCase()} after ${outcome.steps} steps · tokens in/out ${outcome.usage.prompt_tokens}/${outcome.usage.completion_tokens}`);
console.log(`Summary: ${outcome.summary}`);
rawClient().close();
process.exit(outcome.status === "completed" ? 0 : 1);
