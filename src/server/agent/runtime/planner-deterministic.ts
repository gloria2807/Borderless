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

/** Failures caused by the household side (wallet, rules, setup): no other provider would succeed. */
const HOUSEHOLD_SIDE_FAILURES = new Set(["insufficient_testnet_funds", "trustline_missing", "wallet_unverified", "policy_denied", "configuration_error", "approval_terms_mismatch"]);

/** Fallback attempts per utility after the first choice fails. */
const MAX_FALLBACKS = 1;

type Attempt = { outcome: "done" | "stop" } | { outcome: "retry"; why: string };

export async function runDeterministicPlanner(ctx: ToolContext): Promise<PlannerOutcome> {
  let steps = 0;
  const call = async (name: string, args: unknown) => {
    steps += 1;
    return callTool(ctx, name, args);
  };
  if (ctx.directive) return runDirective(ctx, call, () => steps);

  await call("observe_household", {});
  for (const utility of ["electricity", "airtime", "data"] as const) await call("inspect_utility", { utility });
  // Discover over HTTP for every utility that needs attention: who can serve this account,
  // verified against the registry, and what they offer. Nothing is discovered for healthy ones.
  const needing = (await buildDecisionInput(ctx.db, ctx.householdId)).utilities.filter((u) => u.forecast.urgency === "critical" || u.forecast.urgency === "low");
  for (const u of needing) {
    await call("discover_services", { utility: u.kind });
    await call("search_offers", { utility: u.kind, max_price_usdc: null });
  }
  await call("get_allocation_recommendation", {});

  const record = async (d: ReturnType<typeof decide>) => {
    const e = explain(d);
    await appendRunEvent(ctx.db, ctx.runId, {
      stage: "deciding",
      type: "planner.decision",
      decision: d.outcome,
      reason: e.reasoning,
      result: { lines: e.lines, budget: d.budgetImpact, options: d.options, not_needed: d.notNeeded, information: d.information },
    });
    return e;
  };
  let decision = decide(await buildDecisionInput(ctx.db, ctx.householdId));
  let explanation = await record(decision);

  // Procurement: when the decision says information is worth buying first, buy it through
  // x402, then decide again with the report. Once only; never a fixed sequence.
  const toBuy = decision.information.filter((i) => i.action === "buy" && i.providerId);
  if (toBuy.length) {
    let learned = false;
    for (const info of toBuy) {
      await call("discover_information_services", { utility: info.kind });
      const r = (await call("buy_information", { provider_id: info.providerId, reason: info.reason })) as { status?: string; report?: unknown };
      if (r.status === "completed" && r.report) learned = true;
    }
    if (learned) {
      await appendRunEvent(ctx.db, ctx.runId, { stage: "using_result", type: "planner.reassessed", reason: "Re-deciding with the diagnostic report." });
      decision = decide(await buildDecisionInput(ctx.db, ctx.householdId));
      explanation = await record(decision);
    }
  }

  /** What actually happened to each purchase, stated first in the run summary. */
  const outcomes: string[] = [];
  const attempt = async (plan: PlannedPurchase, why: string): Promise<Attempt> => {
    const quote = (await call("request_quote", { utility: plan.kind, provider_id: plan.product.providerId, product_code: plan.product.code })) as { quote_id?: string; error?: string };
    if (!quote.quote_id) return { outcome: "retry", why: quote.error ?? "no quote" };
    const bought = (await call("buy_service", { quote_id: quote.quote_id, reason: why })) as { purchase_id?: string; status?: string; payment_status?: string; failure?: string | null; failure_code?: string | null; reason?: string };
    if (bought.purchase_id && bought.status === "completed") {
      await call("verify_fulfilment", { purchase_id: bought.purchase_id });
      outcomes.push(`${plan.product.label}: paid on Stellar testnet and released.`);
      return { outcome: "done" };
    }
    if (bought.status === "needs_attention") outcomes.push(`${plan.product.label}: payment ${bought.payment_status === "confirmed" ? "confirmed" : bought.payment_status ?? "unclear"}, but the provider did not release it. It can be retried without paying again.`);
    else if (bought.status === "awaiting_owner_approval") outcomes.push(`${plan.product.label}: waiting for your approval; nothing paid.`);
    else if (bought.status === "failed" || bought.status === "refused") outcomes.push(`${plan.product.label}: not bought (${bought.failure ?? bought.reason ?? "failed before payment"}); nothing was charged.`);
    // Only retry elsewhere when nothing was charged; never pay twice for an ambiguous outcome.
    // A different provider only helps with provider-side failures. Wallet, policy and configuration
    // failures would fail the same way anywhere, so they stop here.
    if (bought.status === "failed" && bought.payment_status === "failed" && !HOUSEHOLD_SIDE_FAILURES.has(bought.failure_code ?? "")) {
      return { outcome: "retry", why: bought.failure ?? "the purchase failed before payment" };
    }
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
  const summary = (outcomes.length ? `Outcome: ${outcomes.join(" ")} ` : "") + explanation.headline + ". " + clipAtSentence(explanation.reasoning, 900);
  await call("finish", { summary, monitoring_next: bought ? "Re-assess after the next simulated usage period." : "Re-assess after the next simulated usage period, or when the owner changes the rules." });
  return { status: "completed", summary: ctx.finished?.summary ?? explanation.headline, steps, usage: { prompt_tokens: 0, completion_tokens: 0 } };
}

/**
 * Scenario C: the operator tells Borderless to make one specific purchase. The planner uses the
 * normal tools (price list, quote, dry run, buy), and insists even when the dry run says no —
 * standing in for an agent that has been persuaded to overspend. The wallet's spending rules,
 * evaluated in code before anything is signed, are what stop it.
 */
async function runDirective(ctx: ToolContext, call: (name: string, args: unknown) => Promise<unknown>, steps: () => number): Promise<PlannerOutcome> {
  const d = ctx.directive!;
  await appendRunEvent(ctx.db, ctx.runId, {
    stage: "planning",
    type: "planner.directive",
    utility: d.kind,
    reason: `Operator instruction (demo): buy ₦${d.amountNgn.toLocaleString("en-NG")} of ${d.kind}. Borderless will request it through its normal tools; the wallet's spending rules decide whether any money moves.`,
  });
  await call("observe_household", {});
  await call("inspect_budget", {});
  const search = (await call("search_offers", { utility: d.kind, max_price_usdc: null })) as { offers?: { provider_id: string; price_ngn: number; product_code: string }[] };
  const offer = search.offers?.find((o) => o.price_ngn === d.amountNgn);
  let outcome = `No eligible provider sells exactly ₦${d.amountNgn.toLocaleString("en-NG")} of ${d.kind}.`;
  if (offer) {
    const quote = (await call("request_quote", { utility: d.kind, provider_id: offer.provider_id, product_code: offer.product_code })) as { quote_id?: string; error?: string };
    if (quote.quote_id) {
      await call("evaluate_purchase", { quote_id: quote.quote_id, reason: "Operator instruction (demo)." });
      const bought = (await call("buy_service", { quote_id: quote.quote_id, reason: "Operator instruction (demo): attempting the purchase anyway, so the wallet's own rules decide." })) as { status?: string; reason?: string };
      outcome =
        bought.status === "refused"
          ? `The wallet refused the purchase before anything was signed: ${bought.reason ?? "outside the owner's rules"}. Nothing was paid.`
          : bought.status === "awaiting_owner_approval"
            ? "The purchase is waiting for the owner's approval. Nothing has been paid."
            : `Purchase outcome: ${bought.status}.`;
    } else outcome = `No quote: ${quote.error ?? "the provider did not quote"}.`;
  }
  await call("finish", { summary: outcome, monitoring_next: "Back to normal monitoring." });
  return { status: "completed", summary: ctx.finished?.summary ?? outcome, steps: steps(), usage: { prompt_tokens: 0, completion_tokens: 0 } };
}

/** Shorten to at most `max` characters, ending at a full sentence. */
function clipAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = cut.lastIndexOf(". ");
  return end > 0 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}
