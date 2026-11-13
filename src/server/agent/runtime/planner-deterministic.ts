/**
 * Deterministic planner (no AI). Uses exactly the same tools, policy engine and payment
 * path as the AI planner, but follows the allocation engine's recommendation instead of
 * reasoning about the task. It is a fallback and a baseline, labelled as such in the UI.
 */
import { decide } from "../engine";
import { explain } from "../explain";
import { buildDecisionInput } from "../run";
import { appendRunEvent } from "./run-log";
import { callTool, type ToolContext } from "./tools";
import type { PlannerOutcome } from "./planner-openai";

export async function runDeterministicPlanner(ctx: ToolContext): Promise<PlannerOutcome> {
  let steps = 0;
  const call = async (name: string, args: unknown) => {
    steps += 1;
    return callTool(ctx, name, args);
  };

  await call("observe_household", {});
  for (const utility of ["electricity", "airtime", "data"] as const) await call("inspect_utility", { utility });
  await call("get_allocation_recommendation", {});

  const decision = decide(await buildDecisionInput(ctx.db, ctx.householdId));
  const explanation = explain(decision);
  await appendRunEvent(ctx.db, ctx.runId, {
    stage: "deciding",
    type: "planner.decision",
    decision: decision.outcome,
    reason: explanation.reasoning,
    result: { lines: explanation.lines, budget: decision.budgetImpact },
  });

  for (const plan of decision.selected) {
    await call("compare_offers", { utility: plan.kind });
    const quote = (await call("request_quote", { utility: plan.kind, product_code: plan.product.code })) as { quote_id?: string };
    if (!quote.quote_id) continue;
    const why = explanation.lines.find((l) => l.kind === "decision" && l.utility === plan.kind)?.text ?? `Restores ${plan.kind}.`;
    const bought = (await call("purchase_utility", { quote_id: quote.quote_id, reason: why })) as { purchase_id?: string; status?: string };
    if (bought.purchase_id && bought.status === "completed") await call("verify_fulfilment", { purchase_id: bought.purchase_id });
  }

  if (decision.selected.length) await call("reassess_household", {});
  await call("finish", { summary: explanation.headline + ". " + explanation.reasoning.slice(0, 900), monitoring_next: "Re-assess after the next simulated usage period." });
  return { status: "completed", summary: ctx.finished?.summary ?? explanation.headline, steps, usage: { prompt_tokens: 0, completion_tokens: 0 } };
}
