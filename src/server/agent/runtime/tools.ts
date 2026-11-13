/**
 * The agent's tools. THE AI PROPOSES, THE CODE DECIDES.
 *
 * Every tool reads real application state. The model can never supply an amount,
 * recipient, payee address, provider URL or limit: purchases reference a quote this
 * run obtained, and the quote is re-derived and policy-checked server-side. Arguments
 * are re-validated with Zod regardless of what the model's schema promised.
 *
 * Tool results are returned to the model as DATA. Provider-supplied text is labelled
 * untrusted and is never executed as an instruction.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { env, providerPayTo } from "../../config/env";
import type { Database } from "../../db/client";
import * as s from "../../db/schema";
import { UTILITY_KINDS, type RunStage, type UtilityKind } from "../../db/schema";
import { evaluateSpendingAuthority, summariseBudget, startOfHouseholdDay } from "../../household/policy";
import { loadHousehold } from "../../household/state";
import { formatAtomic, ngnToTestnetUsdcAtomic } from "../../payments/pricing";
import { readUsdcBalanceAtomic, type WalletBalanceReader } from "../../payments/wallet";
import { executePurchase, type BuyerOptions, type BuyerStage } from "../../payments/x402-buyer";
import type { ProviderQuote } from "../../providers/quote-handler";
import { providerQuotePath } from "../../providers/x402-seller";
import { PROVIDER_MODULES } from "../../providers/registry";
import type { Product } from "../../providers/types";
import { createPurchase, OPEN_STAGES, PolicyDeniedError, PurchaseConflictError } from "../../transactions/purchases";
import { forecast, RECENT_WINDOW_HOURS, type Forecast } from "../../usage/forecast";
import { recentSamples } from "../../usage/simulator";
import { coverageAfter, decide, MINIMUM_COVERAGE_HOURS, PREFERRED_COVERAGE_HOURS } from "../engine";
import { buildDecisionInput } from "../run";
import { appendRunEvent, type RunEventInput } from "./run-log";

const r1 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

export interface Quote {
  quoteId: string;
  utility: UtilityKind;
  providerId: string;
  providerName: string;
  product: Product;
  amountNgn: number;
  testnetUsdcAtomic: string;
  payTo: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ToolContext {
  db: Database;
  runId: string;
  householdId: string;
  /** Quotes issued during this run. Purchases may only reference these. */
  quotes: Map<string, Quote>;
  buyer?: Omit<BuyerOptions, "runId" | "onStage">;
  walletBalance?: WalletBalanceReader;
  /** Purchases started by this run (for reassessment / verification scoping). */
  purchaseIds: string[];
  finished?: { summary: string; monitoringNext: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  stage: RunStage;
  /** JSON Schema given to the model (strict: all fields required, no extras). */
  parameters: Record<string, unknown>;
  args: z.ZodType;
  run: (ctx: ToolContext, args: never) => Promise<unknown>;
}

const utilityEnum = { type: "string", enum: [...UTILITY_KINDS] };
const noArgs = { type: "object", properties: {}, required: [], additionalProperties: false };

async function event(ctx: ToolContext, e: RunEventInput) {
  return appendRunEvent(ctx.db, ctx.runId, e);
}

/** Forecast confidence from how much and how steady the observed history is. */
export function forecastConfidence(f: Forecast, samples: { delta: number }[]): { level: "high" | "medium" | "low"; basis: string } {
  if (f.rateSource === "baseline") return { level: "low", basis: "Too little recent usage; using the household's usual rate." };
  const xs = samples.map((x) => x.delta).filter((d) => d > 0);
  const mean = xs.reduce((t, x) => t + x, 0) / Math.max(1, xs.length);
  const sd = Math.sqrt(xs.reduce((t, x) => t + (x - mean) ** 2, 0) / Math.max(1, xs.length));
  const cv = mean > 0 ? sd / mean : 1;
  if (xs.length >= RECENT_WINDOW_HOURS && cv < 0.35) return { level: "high", basis: `${xs.length} recent hourly readings, steady use (variation ${Math.round(cv * 100)}%).` };
  return { level: "medium", basis: `${xs.length} recent hourly readings, variation ${Math.round(cv * 100)}%.` };
}

async function utilityView(db: Database, householdId: string, kind: UtilityKind) {
  const input = await buildDecisionInput(db, householdId);
  const u = input.utilities.find((x) => x.kind === kind);
  if (!u) throw new Error(`No ${kind} account`);
  const samples = await recentSamples(db, u.accountId, input.now, RECENT_WINDOW_HOURS);
  return { input, u, confidence: forecastConfidence(u.forecast, samples) };
}

function forecastSummary(f: Forecast) {
  return {
    balance: r1(f.balance),
    unit: f.unit,
    usage_per_hour: Math.round(f.ratePerHour * 1000) / 1000,
    usage_basis: f.rateSource === "observed" ? `observed over the last ${RECENT_WINDOW_HOURS} hours` : "household's usual rate",
    usual_usage_per_hour: f.baselinePerHour,
    usage_vs_usual: `${f.usageRatio.toFixed(2)}x`,
    unusual_usage: f.unusualUsage,
    hours_of_service_left: r1(f.hoursRemaining),
    limited_by: f.limitedBy,
    predicted_runout: f.depletesAt?.toISOString() ?? null,
    urgency: f.urgency,
  };
}

/**
 * Ask the provider for a real, binding quote (its free quote endpoint). The model only
 * names the utility and a catalogue product; the recipient comes from the household's
 * own account record.
 */
async function requestProviderQuote(ctx: ToolContext, kind: UtilityKind, product: Product): Promise<Quote | { error: string }> {
  const [account] = await ctx.db.select().from(s.utilityAccounts).where(and(eq(s.utilityAccounts.householdId, ctx.householdId), eq(s.utilityAccounts.kind, kind)));
  if (!account) return { error: `The household has no ${kind} account.` };
  const body = {
    accountIdentifier: account.identifier,
    ...(account.network ? { network: account.network } : {}),
    ...(kind === "data" ? { productCode: product.code } : { amountNgn: product.amountNgn }),
  };
  let res: Response;
  try {
    res = await (ctx.buyer?.fetchImpl ?? fetch)(new URL(providerQuotePath(kind), env().APP_BASE_URL).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { error: `The provider could not be reached for a quote (${(err as Error).message}).` };
  }
  const data = (await res.json().catch(() => null)) as ProviderQuote | { code?: string; message?: string } | null;
  if (!res.ok || !data || !("quoteId" in data)) {
    return { error: `The provider did not issue a quote: ${(data as { message?: string } | null)?.message ?? `HTTP ${res.status}`}` };
  }
  const quote: Quote = {
    quoteId: data.quoteId,
    utility: kind,
    providerId: data.providerId,
    providerName: data.providerName,
    product,
    amountNgn: data.amountNgn,
    testnetUsdcAtomic: data.payment.amountAtomic,
    payTo: data.payment.payTo,
    issuedAt: Date.parse(data.issuedAt),
    expiresAt: Date.parse(data.expiresAt),
  };
  const check = revalidateQuote(quote);
  if (!check.valid) return { error: `Quote rejected: ${check.detail}` };
  ctx.quotes.set(quote.quoteId, quote);
  return quote;
}

/**
 * A quote is acceptable only if it is unexpired, pays the provider's REGISTERED wallet
 * (not whatever the provider says), and its testnet USDC matches its NGN price at the
 * household's demo rate. The provider honours its own quoted price until expiry.
 */
function revalidateQuote(q: Quote): { valid: boolean; detail: string } {
  if (Date.now() > q.expiresAt) return { valid: false, detail: `Quote ${q.quoteId} expired. Request a new quote.` };
  if (providerPayTo(q.utility) !== q.payTo) return { valid: false, detail: "The quote's payee is not the provider's registered wallet." };
  if (ngnToTestnetUsdcAtomic(q.amountNgn, env().DEMO_NGN_PER_TESTNET_USDC).toString() !== q.testnetUsdcAtomic) {
    return { valid: false, detail: "The quote's testnet USDC amount does not match its NGN price at the demo rate." };
  }
  return { valid: true, detail: `Quote ${q.quoteId} from ${q.providerName}: unexpired, registered payee, consistent price.` };
}

async function policyFor(ctx: ToolContext, q: Quote, withWallet: boolean) {
  const state = await loadHousehold(ctx.db, ctx.householdId);
  const [account] = await ctx.db.select().from(s.utilityAccounts).where(and(eq(s.utilityAccounts.householdId, ctx.householdId), eq(s.utilityAccounts.kind, q.utility)));
  const [provider] = await ctx.db.select().from(s.utilityProviders).where(eq(s.utilityProviders.id, q.providerId));
  const wallet = withWallet
    ? { availableAtomic: await (ctx.walletBalance ?? readUsdcBalanceAtomic)(env().AGENT_STELLAR_PUBLIC ?? ""), requiredAtomic: BigInt(q.testnetUsdcAtomic) }
    : undefined;
  return evaluateSpendingAuthority(
    { kind: q.utility, providerId: q.providerId, providerAvailable: provider?.available ?? false, network: account?.network ?? null, amountNgn: q.amountNgn, initiatedBy: "agent" },
    state.policy,
    state.budget,
    state.ledger,
    state.household.simulatedNow,
    undefined,
    {
      runId: ctx.runId,
      recipient: account
        ? { permitted: true, detail: `Delivers to the household's registered ${q.utility} account (${account.label}).` }
        : { permitted: false, detail: `The household has no ${q.utility} account.` },
      quote: revalidateQuote(q),
      wallet,
    },
  );
}

const quoteArgs = z.object({ quote_id: z.string().regex(/^qt_[0-9a-z]{10,40}$/), reason: z.string().min(3).max(500) }).strict();

export const TOOLS: ToolDefinition[] = [
  {
    name: "observe_household",
    description: "Read the household's current state: simulated time, every utility balance with its forecast, the remaining household budget, and purchases already in progress. Free.",
    stage: "observing",
    parameters: noArgs,
    args: z.object({}).strict(),
    run: async (ctx) => {
      const input = await buildDecisionInput(ctx.db, ctx.householdId);
      const state = await loadHousehold(ctx.db, ctx.householdId);
      const summary = summariseBudget(state.budget, state.policy, state.ledger);
      return {
        household_time: input.now.toISOString(),
        priorities: input.priorities,
        budget: { remaining_ngn: summary.remainingNgn, committed_ngn: summary.committedNgn, period_ends: state.budget.periodEnd.toISOString() },
        utilities: input.utilities.map((u) => ({ utility: u.kind, ...forecastSummary(u.forecast), purchase_in_progress: u.openPurchase ? { purchase_id: u.openPurchase.id, stage: u.openPurchase.stage } : null })),
        automatic_purchasing: state.policy.autoPurchaseEnabled ? "on" : "off",
      };
    },
  },
  {
    name: "inspect_utility",
    description: "Analyse one utility in depth: balance, observed vs usual consumption, forecast with confidence, and hourly usage for the last 24 hours. Free.",
    stage: "analysing",
    parameters: { type: "object", properties: { utility: utilityEnum }, required: ["utility"], additionalProperties: false },
    args: z.object({ utility: z.enum(UTILITY_KINDS) }).strict(),
    run: async (ctx, args: { utility: UtilityKind }) => {
      const { input, u, confidence } = await utilityView(ctx.db, ctx.householdId, args.utility);
      const last24 = await recentSamples(ctx.db, u.accountId, input.now, 24);
      return {
        utility: args.utility,
        ...forecastSummary(u.forecast),
        forecast_confidence: confidence.level,
        confidence_basis: confidence.basis,
        used_last_24h: Math.round(last24.filter((x) => x.delta > 0).reduce((t, x) => t + x.delta, 0) * 100) / 100,
        note: "Forecasts are estimates from simulated usage, not guarantees.",
      };
    },
  },
  {
    name: "inspect_budget",
    description: "Read how much this household can still spend: household budget left, what this run has spent, and what has been spent today. Free.",
    stage: "analysing",
    parameters: noArgs,
    args: z.object({}).strict(),
    run: async (ctx) => {
      const state = await loadHousehold(ctx.db, ctx.householdId);
      const summary = summariseBudget(state.budget, state.policy, state.ledger);
      const runRows = state.ledger.filter((e) => e.runId === ctx.runId && (e.paymentStatus === "confirmed" || e.paymentStatus === "settled"));
      const dayStart = startOfHouseholdDay(state.household.simulatedNow);
      return {
        household_budget_remaining_ngn: summary.remainingNgn,
        pending_commitments_ngn: summary.committedNgn,
        spent_by_this_run_ngn: runRows.reduce((t, e) => t + e.amountNgn, 0),
        agent_spent_today_ngn: state.ledger.filter((e) => e.initiatedBy !== "owner" && e.createdAt >= dayStart && (e.paymentStatus === "confirmed" || e.paymentStatus === "settled")).reduce((t, e) => t + e.amountNgn, 0),
        note: "The owner's spending rules are enforced by code at purchase time. A purchase may be refused; if so, do not retry it unchanged.",
      };
    },
  },
  {
    name: "discover_providers",
    description: "List providers that can deliver a utility to this household, with availability and their product catalogue. Free.",
    stage: "discovering",
    parameters: { type: "object", properties: { utility: utilityEnum }, required: ["utility"], additionalProperties: false },
    args: z.object({ utility: z.enum(UTILITY_KINDS) }).strict(),
    run: async (ctx, args: { utility: UtilityKind }) => {
      const m = PROVIDER_MODULES[args.utility];
      const [row] = await ctx.db.select().from(s.utilityProviders).where(eq(s.utilityProviders.id, m.definition.id));
      const state = await loadHousehold(ctx.db, ctx.householdId);
      return {
        utility: args.utility,
        providers: [
          {
            provider_id: m.definition.id,
            name: m.definition.name,
            available: row?.available ?? false,
            approved_by_owner: state.policy.approvedProviderIds.includes(m.definition.id),
            payment: "x402, Stellar testnet USDC (fees sponsored by the facilitator)",
            products: m.listProducts().map((p) => ({ product_code: p.code, label: p.label, price_ngn: p.amountNgn, quantity: p.quantity, unit: p.unit, validity_hours: p.validityHours ?? null })),
          },
        ],
        simulated: "Demo provider; fulfilment is simulated.",
      };
    },
  },
  {
    name: "compare_offers",
    description: "Compare every product for a utility: price, how long the household would have service afterwards at the current rate, and cost per day of service. Free.",
    stage: "comparing",
    parameters: { type: "object", properties: { utility: utilityEnum }, required: ["utility"], additionalProperties: false },
    args: z.object({ utility: z.enum(UTILITY_KINDS) }).strict(),
    run: async (ctx, args: { utility: UtilityKind }) => {
      const { u } = await utilityView(ctx.db, ctx.householdId, args.utility);
      const m = PROVIDER_MODULES[args.utility];
      const offers = m.listProducts().map((p) => {
        const cover = coverageAfter(u, p);
        return {
          provider_id: m.definition.id,
          product_code: p.code,
          label: p.label,
          price_ngn: p.amountNgn,
          service_hours_after_purchase: r1(cover),
          ngn_per_day_of_service: Number.isFinite(cover) && cover > 0 ? Math.round((p.amountNgn / cover) * 24) : null,
          meets_minimum_2_days: cover >= MINIMUM_COVERAGE_HOURS,
          meets_preferred_target: cover >= PREFERRED_COVERAGE_HOURS[args.utility],
        };
      });
      return { utility: args.utility, minimum_hours: MINIMUM_COVERAGE_HOURS, preferred_hours: PREFERRED_COVERAGE_HOURS[args.utility], offers };
    },
  },
  {
    name: "get_allocation_recommendation",
    description: "Ask Borderless's deterministic allocation engine what it would buy across all utilities under the current budget and priorities. Advisory only: you may disagree, but explain why.",
    stage: "deciding",
    parameters: noArgs,
    args: z.object({}).strict(),
    run: async (ctx) => {
      const d = decide(await buildDecisionInput(ctx.db, ctx.householdId));
      return {
        recommended: d.selected.map((p) => ({ utility: p.kind, product_code: p.product.code, label: p.product.label, price_ngn: p.product.amountNgn, service_hours_after: r1(p.coverageHours), basis: p.basis, needs_owner_approval: p.requiresApproval })),
        deferred: d.deferred.map((x) => ({ utility: x.kind, reason: x.reason, outranked_by: x.outrankedBy })),
        flags: d.flags,
        ranking: d.assessments.map((a) => ({ utility: a.kind, urgency: a.urgency, score: a.score })),
        budget_after_ngn: d.budgetImpact.remainingAfterNgn,
      };
    },
  },
  {
    name: "request_quote",
    description: "Get a binding quote for one product. Purchases can only be made against a quote from this tool. Quotes expire after 5 minutes. Free.",
    stage: "comparing",
    parameters: {
      type: "object",
      properties: { utility: utilityEnum, product_code: { type: "string", description: "A product_code from discover_providers or compare_offers" } },
      required: ["utility", "product_code"],
      additionalProperties: false,
    },
    args: z.object({ utility: z.enum(UTILITY_KINDS), product_code: z.string().min(1).max(64) }).strict(),
    run: async (ctx, args: { utility: UtilityKind; product_code: string }) => {
      const m = PROVIDER_MODULES[args.utility];
      const product = m.listProducts().find((p) => p.code === args.product_code);
      if (!product) return { error: `Unknown product_code "${args.product_code}" for ${args.utility}. Use one from discover_providers.` };
      const q = await requestProviderQuote(ctx, args.utility, product);
      if ("error" in q) return { error: q.error };
      return {
        quote_id: q.quoteId,
        provider_id: q.providerId,
        product: product.label,
        price_ngn: q.amountNgn,
        testnet_usdc: formatAtomic(q.testnetUsdcAtomic),
        expires_at: new Date(q.expiresAt).toISOString(),
        note: "Testnet USDC has no monetary value; NGN is the household's demo budget.",
      };
    },
  },
  {
    name: "propose_purchase",
    description: "Dry-run a purchase against the owner's spending rules WITHOUT paying. Returns which rules pass, fail, or require owner approval. Free.",
    stage: "deciding",
    parameters: { type: "object", properties: { quote_id: { type: "string" }, reason: { type: "string" } }, required: ["quote_id", "reason"], additionalProperties: false },
    args: quoteArgs,
    run: async (ctx, args: { quote_id: string; reason: string }) => {
      const q = ctx.quotes.get(args.quote_id);
      if (!q) return { error: "Unknown quote_id. Only quotes from request_quote in this run can be used." };
      const r = await policyFor(ctx, q, true);
      await event(ctx, { stage: "checking_policy", type: "policy.evaluated", utility: q.utility, decision: r.outcome, reason: r.violations.map((v) => v.message).join(" ") || null, result: { checks: r.checks, dry_run: true } });
      return {
        outcome: r.outcome === "allow" ? "would be allowed" : r.outcome === "require_approval" ? "would need owner approval" : "would be refused",
        refused_because: r.violations.map((v) => v.message),
        rules: r.checks.map((c) => ({ step: c.step, rule: c.label, result: c.status })),
      };
    },
  },
  {
    name: "purchase_utility",
    description:
      "Buy the product in a quote. This spends real Stellar testnet USDC through x402 (provider returns HTTP 402, the payment is signed, a facilitator settles it on Stellar, then the provider releases the simulated utility). The owner's rules are re-checked in code first and may refuse or require owner approval. If refused, do not retry the same purchase.",
    stage: "requesting_payment",
    parameters: { type: "object", properties: { quote_id: { type: "string" }, reason: { type: "string", description: "One or two sentences: why this purchase, why now, why this size." } }, required: ["quote_id", "reason"], additionalProperties: false },
    args: quoteArgs,
    run: async (ctx, args: { quote_id: string; reason: string }) => {
      const q = ctx.quotes.get(args.quote_id);
      if (!q) return { status: "refused", reason: "Unknown quote_id. Only quotes from request_quote in this run can be used." };
      const quoteCheck = revalidateQuote(q);
      if (!quoteCheck.valid) {
        await event(ctx, { stage: "checking_policy", type: "policy.evaluated", utility: q.utility, decision: "deny", reason: quoteCheck.detail });
        return { status: "refused", reason: quoteCheck.detail };
      }
      await event(ctx, { stage: "deciding", type: "purchase.proposed", utility: q.utility, decision: "purchase", reason: args.reason, input: { quote_id: q.quoteId, product: q.product.label, price_ngn: q.amountNgn } });

      const pre = await policyFor(ctx, q, false);
      await event(ctx, { stage: "checking_policy", type: "policy.evaluated", utility: q.utility, decision: pre.outcome, reason: pre.violations.map((v) => v.message).join(" ") || null, result: { checks: pre.checks } });
      if (pre.outcome === "deny") return { status: "refused", reason: pre.violations.map((v) => v.message).join(" "), note: "Nothing was paid. Do not retry this purchase unchanged." };

      let purchaseId: string;
      try {
        const p = await createPurchase(ctx.db, {
          householdId: ctx.householdId,
          kind: q.utility,
          ...(q.utility === "data" ? { productCode: q.product.code } : { amountNgn: q.amountNgn }),
          initiatedBy: "agent",
          runId: ctx.runId,
          idempotencyKey: `${ctx.runId}:${q.quoteId}`,
          quote: { quoteId: q.quoteId, amountAtomic: q.testnetUsdcAtomic, payTo: q.payTo, expiresAt: new Date(q.expiresAt) },
        });
        purchaseId = p.id;
        ctx.purchaseIds.push(p.id);
        if (p.stage === "awaiting_approval") {
          await event(ctx, { stage: "awaiting_approval", type: "approval.requested", utility: q.utility, purchaseId: p.id, decision: "awaiting_approval", reason: `₦${q.amountNgn.toLocaleString("en-NG")} is above the owner's approval threshold.` });
          return { status: "awaiting_owner_approval", purchase_id: p.id, note: "Nothing has been paid. The owner must approve this purchase; you cannot approve it." };
        }
      } catch (err) {
        if (err instanceof PolicyDeniedError || err instanceof PurchaseConflictError) {
          await event(ctx, { stage: "checking_policy", type: "purchase.refused", utility: q.utility, decision: "deny", reason: err.message });
          return { status: "refused", reason: err.message, note: "Nothing was paid." };
        }
        throw err;
      }

      const result = await executePurchase(ctx.db, purchaseId, {
        ...ctx.buyer,
        walletBalance: ctx.walletBalance ?? ctx.buyer?.walletBalance,
        runId: ctx.runId,
        onStage: async (st: BuyerStage) => {
          if (st.stage === "failed") {
            await event(ctx, { stage: "requesting_payment", type: "payment.failed", utility: q.utility, purchaseId, paymentStatus: st.charged === "no" ? "failed" : "unknown", reason: st.detail, error: st.code });
          } else if (st.stage === "checking_policy") {
            await event(ctx, { stage: "checking_policy", type: "policy.evaluated", utility: q.utility, purchaseId, decision: st.checks.some((c) => c.status === "fail") ? "deny" : "allow", reason: st.detail, result: { checks: st.checks, http_402: { amount_usdc: formatAtomic(st.amountAtomic), pay_to: st.payTo, network: "stellar:testnet", asset: "USDC (testnet)" } } });
          } else {
            await event(ctx, { stage: st.stage, type: `payment.${st.stage}`, utility: q.utility, purchaseId, reason: st.detail, txHash: "txHash" in st ? st.txHash : null });
          }
        },
      });
      const receipt = result.receipt?.fulfilment.status === "fulfilled" ? result.receipt.fulfilment : null;
      await event(ctx, {
        stage: result.fulfilmentStatus === "fulfilled" ? "updating_household" : "verifying_fulfilment",
        type: result.stage === "completed" ? "purchase.completed" : `purchase.${result.stage}`,
        utility: q.utility,
        purchaseId,
        paymentStatus: result.paymentStatus,
        txHash: result.txHash,
        decision: result.stage,
        reason: result.failureMessage,
        result: {
          payment: result.paymentStatus,
          fulfilment: result.fulfilmentStatus,
          explorer: result.explorerUrl,
          balance_before: receipt?.balanceBefore ?? null,
          balance_after: receipt?.balanceAfter ?? null,
          unit: receipt?.unit ?? null,
          demo_token: receipt?.demoToken ?? null,
        },
      });
      return {
        status: result.stage,
        purchase_id: purchaseId,
        payment_status: result.paymentStatus,
        fulfilment_status: result.fulfilmentStatus,
        stellar_tx: result.txHash,
        balance_after: receipt ? `${receipt.balanceAfter} ${receipt.unit}` : null,
        failure: result.failureMessage,
        note: result.stage === "completed" ? "Paid on Stellar testnet and the simulated utility was released." : "Not completed. Report what happened; do not retry unchanged.",
      };
    },
  },
  {
    name: "inspect_transaction",
    description: "Read the stored record of a purchase made in this run: payment status, fulfilment status, Stellar transaction. Free.",
    stage: "verifying_fulfilment",
    parameters: { type: "object", properties: { purchase_id: { type: "string" } }, required: ["purchase_id"], additionalProperties: false },
    args: z.object({ purchase_id: z.string().regex(/^pur_[0-9a-z]+$/) }).strict(),
    run: async (ctx, args: { purchase_id: string }) => {
      if (!ctx.purchaseIds.includes(args.purchase_id)) return { error: "Only purchases made in this run can be inspected." };
      const [p] = await ctx.db.select().from(s.purchases).where(eq(s.purchases.id, args.purchase_id));
      const [pay] = await ctx.db.select().from(s.payments).where(eq(s.payments.purchaseId, args.purchase_id));
      return p ? { purchase_id: p.id, utility: p.kind, amount_ngn: p.amountNgn, stage: p.stage, payment_status: p.paymentStatus, fulfilment_status: p.fulfilmentStatus, stellar_tx: pay?.txHash ?? null, ledger: pay?.ledger ?? null } : { error: "Not found." };
    },
  },
  {
    name: "verify_fulfilment",
    description: "Check that a purchase's simulated utility actually reached the household's virtual device (receipt vs current device balance). Free.",
    stage: "verifying_fulfilment",
    parameters: { type: "object", properties: { purchase_id: { type: "string" } }, required: ["purchase_id"], additionalProperties: false },
    args: z.object({ purchase_id: z.string().regex(/^pur_[0-9a-z]+$/) }).strict(),
    run: async (ctx, args: { purchase_id: string }) => {
      if (!ctx.purchaseIds.includes(args.purchase_id)) return { error: "Only purchases made in this run can be verified." };
      const [p] = await ctx.db.select().from(s.purchases).where(eq(s.purchases.id, args.purchase_id));
      const [rcp] = await ctx.db.select().from(s.receipts).where(eq(s.receipts.purchaseId, args.purchase_id));
      const [bal] = p ? await ctx.db.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, p.accountId)) : [];
      const ful = (rcp?.payload as { fulfilment?: { status: string; balanceAfter?: number; quantity?: number } } | undefined)?.fulfilment;
      return {
        purchase_id: args.purchase_id,
        provider_reports: ful?.status ?? "no receipt",
        released: ful?.quantity ?? null,
        balance_after_release: ful?.balanceAfter ?? null,
        device_balance_now: bal?.balance ?? null,
        verified: ful?.status === "fulfilled" && bal !== undefined,
        simulated: "Simulated utility account; no real meter or phone was credited.",
      };
    },
  },
  {
    name: "reassess_household",
    description: "Re-read every utility after purchases to confirm what is now covered and what still needs attention. Free.",
    stage: "reassessing",
    parameters: noArgs,
    args: z.object({}).strict(),
    run: async (ctx) => {
      const input = await buildDecisionInput(ctx.db, ctx.householdId);
      const open = await ctx.db.select({ id: s.purchases.id, kind: s.purchases.kind, stage: s.purchases.stage }).from(s.purchases).where(and(eq(s.purchases.householdId, ctx.householdId), inArray(s.purchases.stage, OPEN_STAGES)));
      return {
        utilities: input.utilities.map((u) => ({ utility: u.kind, ...forecastSummary(u.forecast) })),
        open_purchases: open,
      };
    },
  },
  {
    name: "finish",
    description: "End the run with a short, evidence-based summary for the household owner and what you will monitor next. Call exactly once, when done.",
    stage: "finished",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "At most 5 sentences, based only on tool results." }, monitoring_next: { type: "string", description: "What to watch next and when to reassess." } },
      required: ["summary", "monitoring_next"],
      additionalProperties: false,
    },
    args: z.object({ summary: z.string().min(1).max(1500), monitoring_next: z.string().min(1).max(600) }).strict(),
    run: async (ctx, args: { summary: string; monitoring_next: string }) => {
      ctx.finished = { summary: args.summary, monitoringNext: args.monitoring_next };
      return { ok: true };
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Validate and run a tool call, recording it in the run log. Never throws to the planner. */
export async function callTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<unknown> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    await event(ctx, { stage: "planning", type: "tool.rejected", tool: name, input: rawArgs, error: "unknown_tool", reason: `No tool named "${name}".` });
    return { error: `Unknown tool "${name}".` };
  }
  const parsed = tool.args.safeParse(rawArgs ?? {});
  const utility = (rawArgs as { utility?: UtilityKind } | null)?.utility;
  if (!parsed.success) {
    await event(ctx, { stage: tool.stage, type: "tool.rejected", tool: name, input: rawArgs, error: "invalid_arguments", reason: parsed.error.issues.map((i) => i.message).join("; ") });
    return { error: `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  }
  await event(ctx, { stage: tool.stage, type: "tool.called", tool: name, utility: UTILITY_KINDS.includes(utility as UtilityKind) ? utility : null, input: parsed.data });
  try {
    const result = await tool.run(ctx, parsed.data as never);
    await event(ctx, { stage: tool.stage, type: "tool.result", tool: name, utility: UTILITY_KINDS.includes(utility as UtilityKind) ? utility : null, result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await event(ctx, { stage: tool.stage, type: "tool.error", tool: name, error: message });
    return { error: `The tool failed: ${message}` };
  }
}
