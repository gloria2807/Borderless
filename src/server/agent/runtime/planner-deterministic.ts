/**
 * Deterministic planner (no AI). Uses exactly the same tools, policy engine and payment
 * path as the AI planner, but follows the allocation engine's recommendation instead of
 * reasoning about the task. It is a fallback and a baseline, labelled as such in the UI.
 *
 * Adaptive: if a provider cannot quote, or a purchase fails before any money moved, the
 * engine re-decides without that provider and the next-best option is tried (once).
 */
import { decide, type PlannedPurchase } from "../engine";
import { explain } from "../explain";
import { buildDecisionInput } from "../run";
import { providerById } from "../../providers/registry";
import { appendRunEvent } from "./run-log";
import { callTool, type ToolContext } from "./tools";
import type { PlannerOutcome } from "./planner-openai";

/** Fallback attempts per utility after the first choice fails. */
const MAX_FALLBACKS = 1;

type Attempt = { outcome: "done" | "stop" } | { outcome: "retry"; why: string };

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
    result: { lines: explanation.lines, budget: decision.budgetImpact, options: decision.options, not_needed: decision.notNeeded },
  });

  const attempt = async (plan: PlannedPurchase, why: string): Promise<Attempt> => {
    const quote = (await call("request_quote", { utility: plan.kind, provider_id: plan.product.providerId, product_code: plan.product.code })) as { quote_id?: string; error?: string };
    if (!quote.quote_id) return { outcome: "retry", why: quote.error ?? "no quote" };
    const bought = (await call("purchase_utility", { quote_id: quote.quote_id, reason: why })) as { purchase_id?: string; status?: string; payment_status?: string; failure?: string | null; reason?: string };
    if (bought.purchase_id && bought.status === "completed") {
      await call("verify_fulfilment", { purchase_id: bought.purchase_id });
      return { outcome: "done" };
    }
    // Only retry elsewhere when nothing was charged; never pay twice for an ambiguous outcome.
    if (bought.status === "failed" && bought.payment_status === "failed") return { outcome: "retry", why: bought.failure ?? "the purchase failed before payment" };
    return { outcome: "stop" };
  };

  let bought = 0;
  for (const first of decision.selected) {
    await call("compare_offers", { utility: first.kind });
    const excluded = new Set<string>();
    let plan: PlannedPurchase | null = first;
    let why = explanation.lines.find((l) => l.kind === "decision" && l.utility === first.kind)?.text ?? `Restores ${first.kind}.`;
    for (let n = 0; plan && n <= MAX_FALLBACKS; n += 1) {
      const result = await attempt(plan, why);
      if (result.outcome === "done") bought += 1;
      if (result.outcome !== "retry") break;

      // Adapt: re-decide with this provider excluded.
      excluded.add(plan.product.providerId);
      const input = await buildDecisionInput(ctx.db, ctx.householdId);
      input.products[plan.kind] = input.products[plan.kind].filter((p) => !excluded.has(p.providerId));
      const next: PlannedPurchase | null = n < MAX_FALLBACKS ? (decide(input).selected.find((p) => p.kind === plan!.kind) ?? null) : null;
      const failedName = providerById(plan.product.providerId)?.definition.name ?? plan.product.providerId;
      await appendRunEvent(ctx.db, ctx.runId, {
        stage: "reassessing",
        type: "planner.adapted",
        utility: plan.kind,
        decision: next ? "try_alternative" : "give_up",
        reason: next
          ? `${failedName} could not complete the purchase (${result.why}). Nothing was charged. Trying ${next.product.label} from ${providerById(next.product.providerId)?.definition.name ?? next.product.providerId} instead.`
          : `${failedName} could not complete the purchase (${result.why}). Nothing was charged, and no other approved option is available now.`,
      });
      why = next ? `Fallback after ${failedName} failed: ${next.product.label} restores about ${Math.round(next.coverageHours)} hours of ${next.kind}.` : why;
      plan = next;
    }
  }

  if (decision.selected.length) await call("reassess_household", {});
  const summary = explanation.headline + ". " + explanation.reasoning.slice(0, 900);
  await call("finish", { summary, monitoring_next: bought ? "Re-assess after the next simulated usage period." : "Re-assess after the next simulated usage period, or when the owner changes the rules." });
  return { status: "completed", summary: ctx.finished?.summary ?? explanation.headline, steps, usage: { prompt_tokens: 0, completion_tokens: 0 } };
}
