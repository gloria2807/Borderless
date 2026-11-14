/**
 * "Simulate low balance" — the primary live demo's trigger.
 *
 * A real backend operation on the SIMULATED household: it lowers the virtual meter's persisted
 * balance to about a day of supply at the current rate, records that as an event, and then starts
 * a genuine agent run, which observes, decides, and (if the rules allow) pays through x402 on
 * Stellar testnet. Nothing here decides what the agent does; the run does.
 */
import { and, eq } from "drizzle-orm";
import { buildDecisionInput } from "../agent/run";
import { AgentPausedError, AgentRunConflictError, AiUnavailableError, startAgentRun, type AgentMode } from "../agent/runtime/executor";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { recordEvent } from "../transactions/events";

/** "About a day left": inside the 36-hour low zone, where Borderless considers buying. */
export const LOW_BALANCE_TARGET_HOURS = 24;

const UNITS: Record<UtilityKind, string> = { electricity: "kWh", airtime: "NGN", data: "MB" };
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface LowBalanceResult {
  kind: UtilityKind;
  balanceBefore: number;
  balanceAfter: number;
  unit: string;
  hoursLeft: number | null;
  /** Started run, or why none was started (paused, already running). */
  runId: string | null;
  runNotStarted: { code: string; message: string; runId?: string } | null;
}

export async function simulateLowBalance(
  db: Database,
  householdId: string,
  opts: { kind?: UtilityKind; mode?: AgentMode; startRun?: boolean; run?: Parameters<typeof startAgentRun>[1] extends infer O ? Partial<O> : never } = {},
): Promise<LowBalanceResult> {
  const kind = opts.kind ?? "electricity";
  const input = await buildDecisionInput(db, householdId);
  const u = input.utilities.find((x) => x.kind === kind);
  if (!u) throw new Error(`The household has no ${kind} account.`);
  const [account] = await db.select().from(s.utilityAccounts).where(and(eq(s.utilityAccounts.householdId, householdId), eq(s.utilityAccounts.kind, kind)));
  const rate = u.forecast.ratePerHour > 0 ? u.forecast.ratePerHour : null;
  const before = u.forecast.balance;
  const target = rate ? round1(rate * LOW_BALANCE_TARGET_HOURS) : round1(before / 4);
  // Lower only. If it is already lower, leave it: the demo never adds supply.
  const after = Math.min(before, target);
  await db.update(s.utilityBalances).set({ balance: after, updatedAt: new Date() }).where(eq(s.utilityBalances.accountId, account!.id));
  const hoursLeft = rate ? round1(after / rate) : null;

  await recordEvent(db, {
    householdId,
    category: "observation",
    type: "demo.low_balance",
    severity: "warning",
    title: `Demo: ${kind} balance lowered to ${after} ${UNITS[kind]}`,
    detail: `Simulated low balance (demo control): ${before} → ${after} ${UNITS[kind]}${hoursLeft !== null ? `, about ${Math.round(hoursLeft)} hours at the current rate` : ""}. Borderless was asked to assess the household.`,
    data: { kind, before, after, hoursLeft },
    simTime: input.now,
  });

  let runId: string | null = null;
  let runNotStarted: LowBalanceResult["runNotStarted"] = null;
  if (opts.startRun !== false) {
    try {
      ({ runId } = await startAgentRun(db, {
        householdId,
        mode: opts.mode ?? "deterministic",
        trigger: "low_balance",
        task: `The household's ${kind} is running low (${after} ${UNITS[kind]} left). Check the household, decide whether to buy, and stay within the owner's spending rules.`,
        ...opts.run,
      }));
    } catch (err) {
      if (err instanceof AgentPausedError) runNotStarted = { code: err.code, message: err.message };
      else if (err instanceof AgentRunConflictError) runNotStarted = { code: err.code, message: err.message, runId: err.runId };
      else if (err instanceof AiUnavailableError) runNotStarted = { code: err.code, message: err.message };
      else throw err;
    }
  }
  return { kind, balanceBefore: before, balanceAfter: after, unit: UNITS[kind], hoursLeft, runId, runNotStarted };
}
