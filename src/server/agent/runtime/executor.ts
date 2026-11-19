/**
 * Agent run executor: one run per household at a time, executed in the background so
 * the HTTP request that starts it returns immediately with a run ID. Everything the
 * run does is persisted to the run log as it happens.
 *
 * Works on one long-lived server and on serverless hosts (Vercel): the background work is
 * kept alive with keepAlive(), a heartbeat in the database shows any instance that the run
 * is alive, and "one run at a time" is checked against the database, not just this process.
 */
import OpenAI from "openai";
import { aiProvider, env } from "../../config/env";
import type { Database } from "../../db/client";
import { loadHousehold } from "../../household/state";
import { sweepInterruptedPurchases } from "../../transactions/sweep";
import type { BuyerOptions } from "../../payments/x402-buyer";
import type { WalletBalanceReader } from "../../payments/wallet";
import { runDeterministicPlanner } from "./planner-deterministic";
import { runAiPlanner, type ChatClient, type PlannerOutcome } from "./planner-openai";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "../../db/schema";
import { keepAlive } from "../../runtime/keep-alive";
import { appendRunEvent, createRun, finishRun, markOrphanedRunsInterrupted, touchRunHeartbeat } from "./run-log";
import { AgentPausedError, agentPaused } from "../run";
import type { ToolContext } from "./tools";

export type AgentMode = "ai" | "deterministic";

export class AgentRunConflictError extends Error {
  readonly code = "agent_busy";
  constructor(readonly runId: string) {
    super("Borderless is already working on a task for this household.");
  }
}

export class AiUnavailableError extends Error {
  readonly code = "ai_unavailable";
}

export { AgentPausedError } from "../run";

const globalRuns = globalThis as unknown as { __borderlessActiveRuns?: Map<string, string> };
const active = (globalRuns.__borderlessActiveRuns ??= new Map<string, string>()); // householdId → runId

export const DEFAULT_TASK =
  "Check the household's electricity, airtime and data. Keep everything powered and connected within the budget: buy only what is needed now, and explain your decisions.";

export interface StartRunOptions {
  householdId: string;
  task?: string;
  mode?: AgentMode;
  trigger?: "manual" | "tick" | "scenario" | "low_balance";
  /** Demo (Scenario C) instruction for the deterministic planner. */
  directive?: ToolContext["directive"];
  /** Test/injection hooks. */
  client?: ChatClient;
  buyer?: Omit<BuyerOptions, "runId" | "onStage">;
  walletBalance?: WalletBalanceReader;
}

export function aiAvailable(): boolean {
  return aiProvider() !== null;
}

export function activeRunFor(householdId: string): string | null {
  return active.get(householdId) ?? null;
}

/** Start a run. Returns immediately with the run ID and a promise for its outcome. */
/**
 * A run marked running that this process is not executing was cut off by a restart or
 * crash: close it as interrupted (its purchases are reconciled by the purchase sweep).
 * Safe to call from read paths; it never touches a run that is genuinely in progress.
 */
/** Silence (no event, no heartbeat) after which a run no process owns is treated as cut off. */
export const ORPHAN_QUIET_MS = 20_000;
/** How often a running run records that it is alive. */
export const HEARTBEAT_MS = 5_000;

export async function reconcileOrphanedRuns(db: Database, householdId: string): Promise<number> {
  return markOrphanedRunsInterrupted(db, householdId, new Set(active.values()), { quietForMs: ORPHAN_QUIET_MS });
}

export async function startAgentRun(db: Database, opts: StartRunOptions): Promise<{ runId: string; done: Promise<PlannerOutcome> }> {
  const existing = active.get(opts.householdId);
  if (existing) throw new AgentRunConflictError(existing);
  if (await agentPaused(db, opts.householdId)) throw new AgentPausedError();

  const mode: AgentMode = opts.mode ?? (aiAvailable() || opts.client ? "ai" : "deterministic");
  let client = opts.client;
  if (mode === "ai" && !client) {
    const ai = aiProvider();
    if (!ai) throw new AiUnavailableError("AI mode needs GEMINI_API_KEY (or OPENAI_API_KEY) in .env.local. Use the deterministic planner, or add a key.");
    client = new OpenAI({ apiKey: ai.apiKey, baseURL: ai.baseURL, maxRetries: 2 }) as unknown as ChatClient;
  }
  const model = mode === "ai" ? (opts.client ? (aiProvider()?.model ?? "scripted") : aiProvider()!.model) : null;

  // Reconcile anything a previous process left behind before starting fresh. A run that is
  // still alive (recent heartbeat) on another server instance blocks this one.
  await reconcileOrphanedRuns(db, opts.householdId);
  const [alive] = await db
    .select({ id: s.agentRuns.id })
    .from(s.agentRuns)
    .where(and(eq(s.agentRuns.householdId, opts.householdId), inArray(s.agentRuns.status, ["running"])))
    .limit(1);
  if (alive) throw new AgentRunConflictError(alive.id);
  await sweepInterruptedPurchases(db, opts.householdId);

  const state = await loadHousehold(db, opts.householdId);
  const task = (opts.task ?? DEFAULT_TASK).trim().slice(0, 600) || DEFAULT_TASK;
  const cfg = env();
  const runId = await createRun(db, {
    householdId: opts.householdId,
    mode,
    model,
    task,
    trigger: opts.trigger ?? "manual",
    simTime: state.household.simulatedNow,
  });
  active.set(opts.householdId, runId);

  await appendRunEvent(db, runId, {
    stage: "planning",
    type: "run.started",
    input: { task, mode, model, household_time: state.household.simulatedNow.toISOString() },
    reason: mode === "ai" ? `AI agent (${model}) is planning the task.` : "Deterministic planner (no AI) is following the allocation engine.",
  });

  const ctx: ToolContext = {
    db,
    runId,
    householdId: opts.householdId,
    quotes: new Map(),
    purchaseIds: [],
    buyer: opts.buyer,
    walletBalance: opts.walletBalance,
    directive: opts.directive,
  };

  const done = (async (): Promise<PlannerOutcome> => {
    let outcome: PlannerOutcome;
    const heartbeat = setInterval(() => void touchRunHeartbeat(db, runId).catch(() => undefined), HEARTBEAT_MS);
    try {
      outcome =
        mode === "ai"
          ? await runAiPlanner(ctx, task, {
              client: client!,
              model: model!,
              maxSteps: cfg.AGENT_MAX_STEPS,
              callTimeoutMs: cfg.AGENT_MODEL_TIMEOUT_SECONDS * 1000,
              reasoningEffort: cfg.AGENT_REASONING_EFFORT,
              deadline: Date.now() + cfg.AGENT_RUN_TIMEOUT_SECONDS * 1000,
            })
          : await runDeterministicPlanner(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await appendRunEvent(db, runId, { stage: "planning", type: "run.error", error: "internal_error", reason: message });
      outcome = { status: "failed", summary: "Stopped by an internal error. Purchases already made stay recorded.", steps: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, error: message };
    } finally {
      clearInterval(heartbeat);
    }
    await appendRunEvent(db, runId, {
      stage: "finished",
      type: outcome.status === "completed" ? "run.completed" : "run.failed",
      reason: outcome.summary,
      result: { monitoring_next: ctx.finished?.monitoringNext ?? null, purchases: ctx.purchaseIds, steps: outcome.steps, usage: outcome.usage },
      error: outcome.error ?? null,
    });
    await finishRun(db, runId, { status: outcome.status, summary: outcome.summary, error: outcome.error ?? null, steps: outcome.steps, usage: outcome.usage });
    active.delete(opts.householdId);
    return outcome;
  })();
  // Serverless hosts freeze a function once it has responded: keep the run going until it ends.
  keepAlive(done);

  return { runId, done };
}
