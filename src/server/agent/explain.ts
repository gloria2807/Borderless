/**
 * Plain-language explanations, generated deterministically from the decision.
 *
 * Every sentence is typed so the UI (and the reader) can tell confirmed facts from
 * observations and predictions. Language rules:
 *  - Balances are facts ("reads", "is").
 *  - Rates are observations ("over the last 6 hours").
 *  - Depletion times are predictions ("likely", "about").
 *  - Unusual usage is reported as a change in this household's usage — never as a
 *    provider error or wrongful deduction, which we have no evidence for.
 */
import type { UtilityKind } from "../db/schema";
import { providerById } from "../providers/registry";
import { RECENT_WINDOW_HOURS } from "../usage/forecast";
import type { Forecast } from "../usage/forecast";
import type { Decision, Deferral, PlannedPurchase } from "./engine";

export type LineKind = "fact" | "observation" | "prediction" | "decision" | "constraint";

export interface ExplanationLine {
  kind: LineKind;
  utility: UtilityKind | null;
  text: string;
}

export interface Explanation {
  headline: string;
  lines: ExplanationLine[];
  /** Single paragraph, for logs and receipts. */
  reasoning: string;
}

const NAME: Record<UtilityKind, string> = { electricity: "Electricity", airtime: "Airtime", data: "Mobile data" };
const noun = (k: UtilityKind) => NAME[k].toLowerCase();
export const naira = (n: number) => `₦${Math.round(n).toLocaleString("en-NG")}`;

export function formatQuantity(value: number, unit: string): string {
  if (unit === "NGN") return naira(value);
  if (unit === "MB" && value >= 1024) return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GB`;
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("en-NG")} ${unit}`;
}

export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours)) return "indefinitely";
  if (hours < 1) return "less than an hour";
  if (hours < 36) {
    const h = Math.round(hours);
    return `about ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(hours / 24);
  return `about ${d} day${d === 1 ? "" : "s"}`;
}

const WAT = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Lagos" });
export const formatSimTime = (d: Date) => WAT.format(d);

function rateText(f: Forecast): string {
  const perHour = f.unit === "NGN" ? naira(f.ratePerHour) : formatQuantity(f.ratePerHour, f.unit);
  return `${perHour} per hour`;
}

function describeForecast(f: Forecast): ExplanationLine[] {
  const lines: ExplanationLine[] = [];
  const k = f.kind;
  const balanceVerb = k === "electricity" ? "The meter reads" : k === "airtime" ? "The airtime balance is" : "The data balance is";
  lines.push({ kind: "fact", utility: k, text: `${balanceVerb} ${formatQuantity(f.balance, f.unit)}.` });

  if (f.rateSource === "observed") {
    lines.push({
      kind: "observation",
      utility: k,
      text: f.unusualUsage
        ? `Use over the last ${RECENT_WINDOW_HOURS} hours averaged ${rateText(f)}, about ${f.usageRatio.toFixed(1)}× this household's usual rate.`
        : `Use over the last ${RECENT_WINDOW_HOURS} hours averaged ${rateText(f)}.`,
    });
  }

  if (f.balance <= 0) {
    lines.push({ kind: "fact", utility: k, text: `${NAME[k]} has run out.` });
  } else if (f.limitedBy === "expiry") {
    lines.push({ kind: "prediction", utility: k, text: `The bundle expires in ${formatDuration(f.hoursRemaining)}, before the data would run out.` });
  } else if (Number.isFinite(f.hoursRemaining)) {
    const when = f.depletesAt ? ` (around ${formatSimTime(f.depletesAt)})` : "";
    lines.push({ kind: "prediction", utility: k, text: `At this rate it is likely to run out in ${formatDuration(f.hoursRemaining)}${when}.` });
  }
  if (f.confidence?.level === "low") lines.push({ kind: "observation", utility: k, text: `Forecast confidence is low: ${f.confidence.basis}` });
  return lines;
}

/** "₦4,000 of electricity" / "3 GB · 30 days data bundle (₦2,000)" — amount stated once. */
function productPhrase(product: { label: string; amountNgn: number; kind: UtilityKind }): string {
  if (product.kind === "data") return `the ${product.label} data bundle (${naira(product.amountNgn)})`;
  return `${naira(product.amountNgn)} of ${noun(product.kind)}`;
}

function describePurchase(p: PlannedPurchase, decision: Decision): string {
  const mine = decision.assessments.find((a) => a.kind === p.kind)!;
  const rival = decision.assessments.find((a) => a.needsAction && a.kind !== p.kind && a.score < mine.score);
  const ranked = rival
    ? ` I'm prioritising ${noun(p.kind)} over ${noun(rival.kind)} because it is ${
        mine.urgency !== rival.urgency ? "more urgent" : "higher in your priorities"
      }.`
    : "";
  const what = productPhrase(p.product);
  const cover = `should last ${formatDuration(p.coverageHours)} at the current rate`;
  if (p.requiresApproval) return `I'd like to buy ${what}, which ${cover}. It is above your approval threshold, so it is waiting for you.${ranked}`;
  if (p.basis === "partial_relief") return `Your limits only allow a small top-up: buying ${what}, which ${cover}. That avoids an outage but is less than I'd normally buy.${ranked}`;
  if (p.basis === "budget_shared") {
    const kept = p.reservedFor.map((r) => `${noun(r.kind)} (${naira(r.amountNgn)})`).join(" and ");
    return `Buying ${what}, which ${cover}. I'm buying less than I otherwise would so the budget also covers ${kept}.${ranked}`;
  }
  if (p.basis === "diagnosed_minimum") {
    const dx = decision.information?.find((i) => i.kind === p.kind && i.code === "avoidable_use");
    return `Buying only ${what}, enough for about two days at the normal rate, because the meter is nearly out.${dx ? " The extra use is avoidable, so I'm not buying for the current rate." : ""}${ranked}`;
  }
  if (p.basis === "best_within_limits") return `Buying ${what}, which ${cover}. That's the most I can buy within your budget and limits without asking you.${ranked}`;
  return `Buying ${what}, which ${cover}.${ranked}`;
}

function describeDeferral(d: Deferral, decision: Decision): ExplanationLine {
  const rec = d.recommendation ? ` I'd recommend ${productPhrase(d.recommendation.product)}.` : "";
  const remaining = naira(decision.budgetImpact.remainingAfterNgn);
  const n = noun(d.kind);
  const text: Record<typeof d.reason, string> = {
    purchase_in_progress: `A ${n} purchase is already in progress, so I'm not starting another.`,
    awaiting_diagnosis: `I'm holding the ${n} purchase until a paid diagnostic explains the unusual use; its finding decides how much to buy.${rec}`,
    diagnosed_avoidable: `The diagnostic found the extra ${n} use avoidable, and there's enough left for now, so I'm not buying more. Fixing the cause matters more than topping up.`,
    unusual_usage: `${NAME[d.kind]} is being used much faster than usual. I'm flagging this for your review rather than automatically buying more — something on the line may be using more ${n} than expected.${rec}`,
    provider_unavailable: `The ${n} provider is unavailable right now, so I can't buy ${n}. I'll check again on the next run.`,
    service_not_approved: `${NAME[d.kind]} isn't an approved service for automatic purchases.${rec}`,
    network_not_approved: `This line's network isn't on your approved list.${rec}`,
    agent_disabled: `Automatic purchasing is off, so I haven't bought ${n}.${rec}`,
    insufficient_budget: d.outrankedBy
      ? `I've deferred ${n}: after ${noun(d.outrankedBy)}, only ${remaining} of the budget remains, which isn't enough for a useful ${n} purchase.${rec} Increase the budget or change priorities if you'd like both.`
      : `The remaining budget (${remaining}) isn't enough for a useful ${n} purchase.${rec} Increase the budget or change priorities so I can act.`,
    insufficient_authority: `Buying ${n} would exceed the spending authority you've given me (${naira(decision.budgetImpact.agentAuthorityAfterNgn)} left).${rec}`,
    over_purchase_limit: `Every useful ${n} purchase is above your per-purchase limit.${rec}`,
    no_eligible_product: `No available ${n} product fits this need.`,
  };
  return { kind: "constraint", utility: d.kind, text: text[d.reason] };
}

export function explain(decision: Decision): Explanation {
  const lines: ExplanationLine[] = [];
  const needs = decision.assessments.filter((a) => a.needsAction || a.forecast.unusualUsage);

  for (const a of needs) lines.push(...describeForecast(a.forecast));
  if (decision.selected.length + decision.deferred.length > 0) {
    lines.push({
      kind: "fact",
      utility: null,
      text: `Budget: ${naira(decision.budgetImpact.remainingBeforeNgn)} remaining; my spending authority has ${naira(decision.budgetImpact.agentAuthorityBeforeNgn)} left.`,
    });
  }
  for (const p of decision.selected) {
    lines.push({ kind: "decision", utility: p.kind, text: describePurchase(p, decision) });
    const why = describeProviderChoice(p, decision);
    if (why) lines.push(why);
    const alt = describeAlternatives(p, decision);
    if (alt) lines.push(alt);
  }
  for (const d of decision.deferred) lines.push(describeDeferral(d, decision));
  for (const i of decision.information ?? []) {
    const line = describeInformation(i);
    if (line) lines.push(line);
  }
  if (decision.selected.length > 0) {
    lines.push({ kind: "decision", utility: null, text: `After this, ${naira(decision.budgetImpact.remainingAfterNgn)} of the budget will remain.` });
  }

  // The "no purchase needed" path, stated explicitly for every utility that was checked.
  const calm = decision.assessments.filter((a) => !a.needsAction && !a.forecast.unusualUsage);
  for (const w of calm) {
    lines.push({
      kind: "prediction",
      utility: w.kind,
      text:
        w.urgency === "watch"
          ? `${NAME[w.kind]} looks fine for now (${formatDuration(w.forecast.hoursRemaining)} left). I'll keep watching it.`
          : `${NAME[w.kind]} doesn't need a purchase (${formatDuration(w.forecast.hoursRemaining)} left).`,
    });
  }

  const headline = headlineFor(decision);
  if (lines.length === 0) lines.push({ kind: "observation", utility: null, text: "Electricity, airtime and data all have comfortable balances. No action needed." });
  return { headline, lines, reasoning: lines.map((l) => l.text).join(" ") };
}

/** The closest alternatives the engine rejected, with the reason (at most two). */
function describeAlternatives(p: PlannedPurchase, decision: Decision): ExplanationLine | null {
  const opts = decision.options?.find((o) => o.kind === p.kind);
  if (!opts) return null;
  // Skip providers excluded wholesale (outage, not approved): the provider-choice line covers them.
  const usable = new Set(decision.candidates.filter((c) => c.kind === p.kind && !c.violations.some((v) => v.code === "provider_unavailable" || v.code === "provider_not_approved")).map((c) => c.product.providerId));
  const rejected = opts.considered.filter((o) => o.status === "rejected" && o.reason && usable.has(o.providerId));
  const cheaper = rejected.filter((o) => o.amountNgn < p.product.amountNgn).sort((a, b) => b.amountNgn - a.amountNgn)[0];
  const pricier = rejected.filter((o) => o.amountNgn > p.product.amountNgn).sort((a, b) => a.amountNgn - b.amountNgn)[0];
  const picks = [cheaper, pricier].filter((o): o is NonNullable<typeof o> => !!o);
  if (!picks.length) return null;
  const name = (id: string) => providerById(id)?.definition.name ?? id;
  const text = picks.map((o) => `${naira(o.amountNgn)} from ${name(o.providerId)} (${o.reason!.replace(/.$/, "").replace(/^./, (c) => c.toLowerCase())})`).join("; ");
  return { kind: "decision", utility: p.kind, text: `Also considered: ${text}.` };
}

/** Why this provider, when more than one could have served the need. */
function describeProviderChoice(p: PlannedPurchase, decision: Decision): ExplanationLine | null {
  const name = (id: string) => providerById(id)?.definition.name ?? id;
  const ofKind = decision.candidates.filter((c) => c.kind === p.kind);
  const others = [...new Set(ofKind.filter((c) => c.product.providerId !== p.product.providerId).map((c) => c.product.providerId))];
  if (others.length === 0) return null;
  const chosen = name(p.product.providerId);
  const excludedBy = (code: string) =>
    others.filter((id) => ofKind.filter((c) => c.product.providerId === id).every((c) => c.violations.some((v) => v.code === code)));
  const list = (ids: string[]) => `${ids.map(name).join(" and ")} ${ids.length > 1 ? "are" : "is"}`;

  const down = excludedBy("provider_unavailable");
  if (down.length) return { kind: "constraint", utility: p.kind, text: `${list(down)} unavailable right now, so I'm buying from ${chosen}.` };
  const unapproved = excludedBy("provider_not_approved");
  if (unapproved.length === others.length) return { kind: "constraint", utility: p.kind, text: `Buying from ${chosen}: ${list(unapproved)} not on your approved list.` };
  return { kind: "decision", utility: p.kind, text: `I compared ${others.length + 1} providers; ${chosen} gives the household the best value for this need.` };
}

/** Whether information was (or will be) bought before deciding, and why. */
function describeInformation(i: Decision["information"][number]): ExplanationLine | null {
  if (i.action === "buy") {
    const alt = i.alternatives?.length ? ` Not ${i.alternatives.map((a) => `${a.name} (${naira(a.priceNgn)}): ${a.why.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}`).join("; ")}.` : "";
    return { kind: "decision", utility: i.kind, text: `${i.reason} Buying a diagnostic from ${i.providerName} for ${naira(i.priceNgn ?? 0)}.${alt}` };
  }
  if (i.action === "not_worth_it") return { kind: "constraint", utility: i.kind, text: `Not buying a diagnostic: ${i.reason.charAt(0).toLowerCase()}${i.reason.slice(1)}` };
  if (i.code === "genuine_use") return { kind: "observation", utility: i.kind, text: `Diagnostic finding: ${i.reason} So I'm sizing the purchase for the current rate.` };
  if (i.code === "avoidable_use") return { kind: "observation", utility: i.kind, text: `Diagnostic finding: ${i.reason}` };
  return null;
}

function headlineFor(d: Decision): string {
  const buying = d.selected.filter((p) => !p.requiresApproval);
  const approval = d.selected.filter((p) => p.requiresApproval);
  if (buying.length) return `Buying ${buying.map((p) => `${noun(p.kind)} (${naira(p.product.amountNgn)})`).join(" and ")}`;
  if (approval.length) return `${NAME[approval[0]!.kind]} purchase needs your approval`;
  const info = (d.information ?? []).find((i) => i.action === "buy");
  if (info) return `Checking unusual ${noun(info.kind)} use first (diagnostic, ${naira(info.priceNgn ?? 0)})`;
  if (d.deferred.some((x) => x.reason === "diagnosed_avoidable")) return `${NAME[d.deferred.find((x) => x.reason === "diagnosed_avoidable")!.kind]} use is avoidable — fix the cause before buying more`;
  if (d.deferred.some((x) => x.reason === "unusual_usage")) return `Unusual ${noun(d.deferred.find((x) => x.reason === "unusual_usage")!.kind)} usage — review before buying`;
  const blocked = d.deferred.find((x) => x.reason !== "purchase_in_progress");
  if (blocked) return `Can't buy ${noun(blocked.kind)} — ${blocked.reason.replace(/_/g, " ")}`;
  if (d.deferred.length) return "Purchase already in progress";
  const watching = (d.information ?? []).find((i) => i.code === "not_urgent");
  if (watching) return `${NAME[watching.kind]} use is up — watching; no purchase needed yet`;
  return "Household is powered and connected";
}
