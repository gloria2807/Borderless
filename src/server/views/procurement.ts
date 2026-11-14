/**
 * Procurement inspection (amendment A4): every step of one paid acquisition, assembled
 * only from what the backend recorded — the provider and its published document, the
 * protected endpoint, the provider's actual HTTP 402, the price, the policy evaluation,
 * the approval record, the Stellar transaction, the released resource, and what the agent
 * did next. Nothing here is reconstructed or invented; missing steps are shown as missing.
 */
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "../db/client";
import * as s from "../db/schema";
import { explorerTxUrl } from "../payments/horizon";
import { formatAtomic } from "../payments/pricing";
import { serviceDocument, verifyServiceDocument } from "../providers/catalog";
import { providerById, providerPayTo, requireProvider } from "../providers/registry";
import { providerRoutePath } from "../providers/x402-seller";

export interface ProcurementStep {
  key: string;
  title: string;
  /** "recorded" = backend data shown; "not_applicable"/"not_reached" = honestly absent. */
  status: "recorded" | "not_applicable" | "not_reached";
}

export interface PolicyCheckView {
  step: number;
  label: string;
  status: string;
  detail: string;
}

export interface ProcurementView {
  purchase: {
    id: string;
    kind: string;
    serviceType: string;
    label: string;
    amountNgn: number;
    stage: string;
    paymentStatus: string;
    fulfilmentStatus: string;
    initiatedBy: string;
    runId: string | null;
  };
  provider: { id: string; name: string; category: string; description: string; serviceDocument: string; verified: boolean; problems: string[]; registeredPayTo: string | null };
  discovery: { inRun: boolean; tool: string | null; at: string | null };
  endpoint: { method: "POST"; path: string; protocol: "x402" };
  price: { source: "quote" | "published_price"; quoteId: string | null; amountNgn: number; amountAtomic: string | null; amountUsdc: string | null; expiresAt: string | null };
  http402: { status: 402; x402Version: unknown; resource: unknown; accepts: { scheme: string; network: string; asset: string; amount: string; amountUsdc: string; payTo: string; maxTimeoutSeconds: number | null }[]; raw: unknown } | null;
  policy: { outcome: string; checks: PolicyCheckView[]; at: string } | null;
  approval: { required: boolean; termsHash: string | null; terms: unknown; expiresAt: string | null; outcome: string | null; at: string | null };
  payment: { network: string; asset: string | null; scheme: string | null; amountAtomic: string | null; amountUsdc: string | null; payTo: string | null; payer: string | null; txHash: string | null; ledger: number | null; explorerUrl: string | null; status: string } | null;
  released: { type: "utility" | "report"; receiptId: string | null; quantity: number | null; unit: string | null; balanceBefore: number | null; balanceAfter: number | null; demoToken: string | null; report: unknown } | null;
  next: { source: "run" | "decision" | "none"; items: { at: string; title: string; detail: string | null }[] };
  steps: ProcurementStep[];
}

const usdc = (atomic: string | null | undefined) => (atomic ? formatAtomic(atomic) : null);

export async function getProcurement(householdId: string, purchaseId: string): Promise<ProcurementView | null> {
  const database = db();
  const [p] = await database.select().from(s.purchases).where(eq(s.purchases.id, purchaseId));
  if (!p || p.householdId !== householdId) return null;
  const module = providerById(p.providerId) ?? requireProvider(p.providerId);
  const [pay] = await database.select().from(s.payments).where(eq(s.payments.purchaseId, p.id));
  const [rcp] = await database.select().from(s.receipts).where(eq(s.receipts.purchaseId, p.id));
  const events = await database.select().from(s.activityEvents).where(eq(s.activityEvents.purchaseId, p.id)).orderBy(asc(s.activityEvents.createdAt));
  const doc = await serviceDocument(database, module);
  const check = verifyServiceDocument(p.providerId, doc);
  let registeredPayTo: string | null = null;
  try {
    registeredPayTo = providerPayTo(p.providerId);
  } catch {
    registeredPayTo = null;
  }

  // Discovery and the agent's next actions, from the run log when the agent bought it.
  const runEvents = p.runId ? await database.select().from(s.agentRunEvents).where(eq(s.agentRunEvents.runId, p.runId)).orderBy(asc(s.agentRunEvents.seq)) : [];
  const discoveryTool = module.service ? "discover_information_services" : "discover_services";
  const discovered = runEvents.find((e) => e.type === "tool.result" && e.tool === discoveryTool && JSON.stringify(e.result ?? {}).includes(`"${p.providerId}"`));

  // The provider's actual HTTP 402, as the buyer received and stored it.
  const pr = pay?.paymentRequired as { x402Version?: unknown; resource?: unknown; accepts?: Record<string, unknown>[] } | null | undefined;
  const http402 = pr?.accepts
    ? {
        status: 402 as const,
        x402Version: pr.x402Version ?? null,
        resource: pr.resource ?? null,
        accepts: pr.accepts.map((a) => ({
          scheme: String(a.scheme),
          network: String(a.network),
          asset: String(a.asset),
          amount: String(a.amount),
          amountUsdc: usdc(String(a.amount)) ?? "",
          payTo: String(a.payTo),
          maxTimeoutSeconds: typeof a.maxTimeoutSeconds === "number" ? a.maxTimeoutSeconds : null,
        })),
        raw: pr,
      }
    : null;

  const policyEvent = [...events].reverse().find((e) => e.type === "policy.checked");
  const pData = (policyEvent?.data ?? null) as { outcome?: string; checks?: PolicyCheckView[] } | null;
  const approvalEvent = [...events].reverse().find((e) => ["purchase.approved", "purchase.declined", "purchase.approval_expired"].includes(e.type));
  const fulfilment = (rcp?.payload as { receiptId?: string; fulfilment?: { status?: string; quantity?: number; unit?: string; balanceBefore?: number; balanceAfter?: number; demoToken?: string | null; details?: { result?: unknown } } } | undefined) ?? undefined;
  const released =
    fulfilment?.fulfilment?.status === "fulfilled"
      ? {
          type: (module.service ? "report" : "utility") as "report" | "utility",
          receiptId: fulfilment.receiptId ?? null,
          quantity: fulfilment.fulfilment.quantity ?? null,
          unit: fulfilment.fulfilment.unit ?? null,
          balanceBefore: module.service ? null : (fulfilment.fulfilment.balanceBefore ?? null),
          balanceAfter: module.service ? null : (fulfilment.fulfilment.balanceAfter ?? null),
          demoToken: fulfilment.fulfilment.demoToken ?? null,
          report: fulfilment.fulfilment.details?.result ?? null,
        }
      : null;

  // What the agent did next with the resource.
  let next: ProcurementView["next"] = { source: "none", items: [] };
  const completedAt = runEvents.find((e) => e.purchaseId === p.id && e.type === "purchase.completed");
  if (completedAt) {
    const after = runEvents.filter((e) => e.seq > completedAt.seq && ["planner.reassessed", "planner.decision", "model.message", "tool.called", "purchase.completed", "run.completed"].includes(e.type)).slice(0, 6);
    next = {
      source: "run",
      items: after.map((e) => ({
        at: e.at.toISOString(),
        title:
          e.type === "tool.called" ? `Called ${e.tool}` : e.type === "planner.reassessed" ? "Re-decided with the result" : e.type === "planner.decision" ? `Decision: ${String(e.decision).replace(/_/g, " ")}` : e.type === "model.message" ? "Agent" : e.type === "purchase.completed" ? "Next purchase completed" : "Run completed",
        detail: e.type === "tool.called" ? JSON.stringify(e.input) : (e.reason ?? null),
      })),
    };
  } else if (p.stage === "completed") {
    const [later] = await database
      .select()
      .from(s.activityEvents)
      .where(and(eq(s.activityEvents.householdId, householdId), eq(s.activityEvents.category, "decision"), gt(s.activityEvents.createdAt, p.updatedAt)))
      .orderBy(asc(s.activityEvents.createdAt))
      .limit(1);
    if (later && later.type.startsWith("decision.")) next = { source: "decision", items: [{ at: later.createdAt.toISOString(), title: later.title, detail: later.detail }] };
  }

  const paidPath = module.service ? `/api/services/${p.providerId}/${module.service.slug}` : providerRoutePath(p.providerId);
  const view: Omit<ProcurementView, "steps"> = {
    purchase: { id: p.id, kind: p.kind, serviceType: p.serviceType, label: module.resolveProduct(p.kind === "data" || module.service ? { productCode: p.productCode } : { amountNgn: p.amountNgn }).label, amountNgn: p.amountNgn, stage: p.stage, paymentStatus: p.paymentStatus, fulfilmentStatus: p.fulfilmentStatus, initiatedBy: p.initiatedBy, runId: p.runId },
    provider: { id: p.providerId, name: module.definition.name, category: module.definition.category, description: doc.description, serviceDocument: `/api/providers/${p.providerId}/service`, verified: check.verified, problems: check.problems, registeredPayTo },
    discovery: { inRun: !!discovered, tool: discovered ? discoveryTool : null, at: discovered?.at.toISOString() ?? null },
    endpoint: { method: "POST", path: paidPath, protocol: "x402" },
    price: module.service
      ? { source: "published_price", quoteId: null, amountNgn: p.amountNgn, amountAtomic: pay?.amountAtomic ?? null, amountUsdc: usdc(pay?.amountAtomic), expiresAt: null }
      : { source: "quote", quoteId: p.quoteId, amountNgn: p.amountNgn, amountAtomic: p.quoteAmountAtomic, amountUsdc: usdc(p.quoteAmountAtomic), expiresAt: p.quoteExpiresAt?.toISOString() ?? null },
    http402,
    policy: policyEvent && pData ? { outcome: pData.outcome ?? "unknown", checks: pData.checks ?? [], at: policyEvent.createdAt.toISOString() } : null,
    approval: {
      required: !!p.approvalTermsHash,
      termsHash: p.approvalTermsHash,
      terms: p.approvalTerms,
      expiresAt: p.approvalExpiresAt?.toISOString() ?? null,
      outcome: approvalEvent ? approvalEvent.type.replace("purchase.", "") : p.approvalTermsHash && p.stage === "awaiting_approval" ? "pending" : null,
      at: approvalEvent?.createdAt.toISOString() ?? null,
    },
    payment: pay
      ? { network: pay.network, asset: pay.asset, scheme: pay.scheme, amountAtomic: pay.amountAtomic, amountUsdc: usdc(pay.amountAtomic), payTo: pay.payTo, payer: pay.payer, txHash: pay.txHash, ledger: pay.ledger, explorerUrl: pay.txHash ? explorerTxUrl(pay.txHash) : null, status: pay.status }
      : null,
    released,
    next,
  };

  const reached = (ok: boolean, applicable = true): ProcurementStep["status"] => (!applicable ? "not_applicable" : ok ? "recorded" : "not_reached");
  const steps: ProcurementStep[] = [
    { key: "provider", title: "Discovered provider", status: reached(true) },
    { key: "description", title: "Service description", status: reached(!!view.provider.description) },
    { key: "endpoint", title: "Protected endpoint", status: reached(true) },
    { key: "http402", title: "HTTP 402 response", status: reached(!!http402) },
    { key: "price", title: "Quoted price", status: reached(!!view.price.amountAtomic) },
    { key: "asset", title: "Payment asset and network", status: reached(!!http402 || !!pay) },
    { key: "policy", title: "Policy decision", status: reached(!!view.policy) },
    { key: "approval", title: "Approval record", status: reached(!!view.approval.outcome, view.approval.required) },
    { key: "transaction", title: "Stellar transaction", status: reached(!!pay?.txHash) },
    { key: "released", title: "Released resource", status: reached(!!released) },
    { key: "next", title: "Agent's next action", status: reached(next.items.length > 0, p.initiatedBy === "agent") },
  ];
  return { ...view, steps };
}

