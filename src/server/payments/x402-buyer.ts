/**
 * The agent's x402 buyer. The ONLY module that touches the agent signing key.
 *
 *  purchase(requested) → re-check authority → POST provider → 402
 *    → validate requirements against OUR quote (asset, network, payTo, amount)
 *    → sign Soroban auth entry (server-side) → retry with PAYMENT-SIGNATURE
 *    → provider verifies + settles via facilitator → receipt + PAYMENT-RESPONSE
 *    → independently confirm the transfer on Horizon → record receipt
 *
 * Every step is persisted, so a crash or refresh never loses the payment trail.
 */
import { eq } from "drizzle-orm";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer, InsufficientBalanceError, SimulationFailedError, TrustlineMissingError } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { z } from "zod";
import { agentSecret, env, providerPayTo } from "../config/env";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { PaymentStatus, PurchaseStage, FulfilmentStatus } from "../db/schema";
import { evaluateSpendingAuthority } from "../household/policy";
import { loadHousehold } from "../household/state";
import { newId } from "../lib/ids";
import type { ProviderReceipt } from "../providers/receipt";
import { providerRoutePath, quoteOrderAtomic } from "../providers/x402-seller";
import { recordEvent } from "../transactions/events";
import { confirmOnHorizon, explorerTxUrl } from "./horizon";
import { formatAtomic, ngnToTestnetUsdcAtomic, TESTNET_USDC } from "./pricing";

export type PurchaseRow = typeof s.purchases.$inferSelect;

export interface ExecuteResult {
  purchaseId: string;
  stage: PurchaseStage;
  paymentStatus: PaymentStatus;
  fulfilmentStatus: FulfilmentStatus;
  txHash: string | null;
  explorerUrl: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  receipt: ProviderReceipt | null;
}

export interface BuyerOptions {
  fetchImpl?: typeof fetch;
  /** Skip Horizon confirmation (unit tests only). */
  horizon?: typeof confirmOnHorizon;
}

const receiptSchema = z
  .object({
    receiptId: z.string(),
    simulated: z.literal(true),
    purchaseId: z.string(),
    payment: z.object({ txHash: z.string().regex(/^[0-9a-f]{64}$/), amountAtomic: z.string(), settledAt: z.string() }).loose(),
    fulfilment: z.object({ status: z.enum(["fulfilled", "pending", "failed"]) }).loose(),
  })
  .loose();

// ── helpers ─────────────────────────────────────────────────────────────────

class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly charged: "no" | "yes" | "unknown",
  ) {
    super(message);
  }
}

async function update(db: Database, purchaseId: string, patch: Partial<typeof s.purchases.$inferInsert>) {
  await db.update(s.purchases).set({ ...patch, updatedAt: new Date() }).where(eq(s.purchases.id, purchaseId));
}

async function upsertPayment(db: Database, purchaseId: string, patch: Partial<typeof s.payments.$inferInsert>) {
  const [existing] = await db.select().from(s.payments).where(eq(s.payments.purchaseId, purchaseId));
  if (existing) {
    await db.update(s.payments).set({ ...patch, updatedAt: new Date() }).where(eq(s.payments.id, existing.id));
  } else {
    await db.insert(s.payments).values({
      id: newId("pay"),
      purchaseId,
      network: env().STELLAR_NETWORK,
      status: "not_started",
      ...patch,
    });
  }
}

function buildClient(maxPerPaymentUsd: string, expected: (r: PaymentRequirements) => boolean) {
  const signer = createEd25519Signer(agentSecret(), env().STELLAR_NETWORK);
  const core = new x402Client()
    .register("stellar:*", new ExactStellarScheme(signer, { url: env().STELLAR_RPC_URL }))
    // SDK-level spend cap (defence in depth; our NGN policy is the primary control).
    .setSpendControls({ maxAmountPerPayment: maxPerPaymentUsd })
    // Only ever pay requirements that exactly match our own quote.
    .registerPolicy((_v, reqs) => reqs.filter(expected));
  return { http: new x402HTTPClient(core), payer: signer.address };
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

// ── main entry ──────────────────────────────────────────────────────────────

export async function executePurchase(db: Database, purchaseId: string, options: BuyerOptions = {}): Promise<ExecuteResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const horizon = options.horizon ?? confirmOnHorizon;

  const [purchase] = await db.select().from(s.purchases).where(eq(s.purchases.id, purchaseId));
  if (!purchase) throw new Error(`Purchase ${purchaseId} not found`);
  if (purchase.stage !== "requested") {
    // Idempotent: executing a purchase that is past "requested" never pays again.
    return summarise(db, purchaseId);
  }

  const state = await loadHousehold(db, purchase.householdId);
  const simTime = state.household.simulatedNow;
  const event = (e: Omit<Parameters<typeof recordEvent>[1], "householdId" | "purchaseId" | "simTime">) =>
    recordEvent(db, { ...e, householdId: purchase.householdId, purchaseId, decisionId: purchase.decisionId ?? undefined, simTime });

  const [account] = await db.select().from(s.utilityAccounts).where(eq(s.utilityAccounts.id, purchase.accountId));
  const [provider] = await db.select().from(s.utilityProviders).where(eq(s.utilityProviders.id, purchase.providerId));
  if (!account || !provider) throw new Error("Purchase references a missing account or provider");

  try {
    // 1. Authority re-check immediately before any payment activity.
    const authority = evaluateSpendingAuthority(
      {
        kind: purchase.kind,
        providerId: provider.id,
        providerAvailable: provider.available,
        network: account.network,
        amountNgn: purchase.amountNgn,
        initiatedBy: purchase.initiatedBy,
        ownerApproved: purchase.initiatedBy === "owner" || undefined,
      },
      state.policy,
      state.budget,
      state.ledger,
      simTime,
      purchaseId,
    );
    if (authority.outcome === "deny") {
      throw new StepError("policy_denied", authority.violations.map((v) => v.message).join(" "), "no");
    }

    // 2. Our own quote — the only amount we will ever sign for.
    const order = {
      purchaseId,
      accountIdentifier: account.identifier,
      ...(account.network ? { network: account.network } : {}),
      ...(purchase.kind === "data" ? { productCode: purchase.productCode } : { amountNgn: purchase.amountNgn }),
    };
    const expectedAtomic = quoteOrderAtomic(purchase.kind, order);
    const expectedPayTo = providerPayTo(purchase.kind);
    const isExpected = (r: PaymentRequirements) =>
      r.scheme === "exact" &&
      r.network === env().STELLAR_NETWORK &&
      r.asset === TESTNET_USDC.contract &&
      r.payTo === expectedPayTo &&
      r.amount === expectedAtomic.toString();

    // 3. Request the utility. Expect HTTP 402.
    const url = new URL(providerRoutePath(purchase.kind), env().APP_BASE_URL).toString();
    const init = (headers: Record<string, string> = {}): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(order),
    });

    await event({ category: "payment", type: "provider.requested", severity: "info", title: `Requested ${purchase.kind} from ${provider.name}`, detail: `POST ${providerRoutePath(purchase.kind)}` });
    let first: Response;
    try {
      first = await doFetch(url, { ...init(), signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new StepError("provider_unreachable", `Could not reach ${provider.name}: ${(err as Error).message}`, "no");
    }

    if (first.status === 200) {
      // Provider already fulfilled this purchase id earlier (idempotent replay) — no new payment.
      return await recordSuccess(db, purchase, (await readBody(first)) as ProviderReceipt, null, horizon, event, true);
    }
    if (first.status !== 402) {
      const body = (await readBody(first)) as { code?: string; message?: string } | null;
      throw new StepError(body?.code ?? `http_${first.status}`, body?.message ?? `Provider answered HTTP ${first.status} instead of 402.`, "no");
    }

    const maxUsd = `$${formatAtomic(ngnToTestnetUsdcAtomic(state.policy.perPurchaseLimitNgn, env().DEMO_NGN_PER_TESTNET_USDC))}`;
    const { http, payer } = buildClient(maxUsd, isExpected);
    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n), await readBody(first));
    } catch (err) {
      throw new StepError("invalid_payment_required", `The provider's payment requirements could not be read: ${(err as Error).message}`, "no");
    }
    const offered = paymentRequired.accepts.find(isExpected);
    await update(db, purchaseId, { stage: "payment_required", paymentStatus: "requires_payment" });
    await upsertPayment(db, purchaseId, {
      status: "requires_payment",
      scheme: offered?.scheme ?? paymentRequired.accepts[0]?.scheme ?? null,
      asset: offered?.asset ?? null,
      amountAtomic: offered?.amount ?? null,
      payTo: offered?.payTo ?? null,
      payer,
      paymentRequired,
    });
    if (!offered) {
      throw new StepError(
        "requirements_mismatch",
        "The provider asked for a payment that does not match Borderless's quote (asset, network, recipient or amount). Nothing was signed.",
        "no",
      );
    }
    await event({
      category: "payment",
      type: "payment.required",
      severity: "info",
      title: `HTTP 402 — ${formatAtomic(offered.amount)} testnet USDC required`,
      detail: `Pay to ${offered.payTo.slice(0, 6)}…${offered.payTo.slice(-6)} on Stellar testnet. Matches our quote for ₦${purchase.amountNgn.toLocaleString("en-NG")}.`,
      data: { amountAtomic: offered.amount, payTo: offered.payTo, maxTimeoutSeconds: offered.maxTimeoutSeconds },
    });

    // 4. Sign (server-side). Simulation catches insufficient funds / missing trustline before anything is submitted.
    let payload: PaymentPayload;
    try {
      payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [offered] });
    } catch (err) {
      if (err instanceof InsufficientBalanceError) throw new StepError("insufficient_testnet_funds", "The agent wallet does not have enough testnet USDC. Nothing was charged.", "no");
      if (err instanceof TrustlineMissingError) throw new StepError("trustline_missing", "The agent wallet has no USDC trustline. Nothing was charged.", "no");
      if (err instanceof SimulationFailedError) throw new StepError("payment_simulation_failed", `The payment could not be simulated: ${err.message}`, "no");
      throw new StepError("signing_failed", `The payment could not be signed: ${(err as Error).message}`, "no");
    }

    // 5. Submit. From here on the outcome may be "charged", so failures become "unknown" until reconciled.
    await update(db, purchaseId, { stage: "submitted", paymentStatus: "submitted" });
    await upsertPayment(db, purchaseId, { status: "submitted" });
    await event({ category: "payment", type: "payment.submitted", severity: "info", title: "Payment authorised and sent", detail: "Signed Soroban authorisation sent to the provider for facilitator verification and settlement." });

    let paid: Response;
    try {
      paid = await doFetch(url, { ...init(http.encodePaymentSignatureHeader(payload)), signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      throw new StepError("network_interrupted", `Connection lost after the payment was sent: ${(err as Error).message}. Borderless will reconcile before trying again.`, "unknown");
    }

    const body = await readBody(paid);
    if (paid.status === 200) {
      const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
      return await recordSuccess(db, purchase, body as ProviderReceipt, { txHash: settle.transaction, payer, payTo: expectedPayTo, amountAtomic: expectedAtomic }, horizon, event, false);
    }

    // Did the provider settle but fail to fulfil?
    let settledTx: string | null = null;
    try {
      const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
      if (settle.success && settle.transaction) settledTx = settle.transaction;
    } catch {
      /* no PAYMENT-RESPONSE header */
    }
    if (settledTx) {
      await markSettled(db, purchaseId, settledTx);
      const confirmation = await horizon({ txHash: settledTx, from: payer, to: expectedPayTo, amountAtomic: expectedAtomic });
      if (confirmation.status === "confirmed") await markConfirmed(db, purchaseId, confirmation.ledger);
      const reason = (body as { message?: string } | null)?.message ?? `Provider answered HTTP ${paid.status}.`;
      await update(db, purchaseId, {
        stage: "needs_attention",
        fulfilmentStatus: "failed",
        failureCode: (body as { code?: string } | null)?.code ?? "fulfilment_failed",
        failureMessage: reason,
      });
      await event({ category: "payment", type: "payment.settled", severity: "success", title: "Payment confirmed on Stellar testnet", detail: settledTx, data: { txHash: settledTx, explorerUrl: explorerTxUrl(settledTx) } });
      await event({ category: "fulfilment", type: "fulfilment.failed", severity: "critical", title: "Provider did not release the utility", detail: `${reason} You have not been charged twice; Borderless can retry fulfilment without a new payment.` });
      return summarise(db, purchaseId);
    }

    if (paid.status === 402) {
      let reason = "The facilitator rejected the payment.";
      try {
        const pr = http.getPaymentRequiredResponse((n) => paid.headers.get(n), body);
        if (pr.error) reason = `The facilitator rejected the payment: ${pr.error}.`;
      } catch {
        /* keep generic reason */
      }
      throw new StepError("payment_rejected", `${reason} Nothing was charged.`, "no");
    }
    if (paid.status === 409) {
      throw new StepError((body as { code?: string } | null)?.code ?? "conflict", (body as { message?: string } | null)?.message ?? "Provider reported a conflict.", "unknown");
    }
    throw new StepError(
      (body as { code?: string } | null)?.code ?? `http_${paid.status}`,
      `${(body as { message?: string } | null)?.message ?? `Provider answered HTTP ${paid.status}.`} Payment outcome will be reconciled.`,
      "unknown",
    );
  } catch (err) {
    const step = err instanceof StepError ? err : new StepError("unexpected_error", (err as Error).message ?? String(err), "unknown");
    if (step.charged === "no") {
      await update(db, purchaseId, { stage: "failed", paymentStatus: "failed", failureCode: step.code, failureMessage: step.message });
      await upsertPayment(db, purchaseId, { status: "failed", errorCode: step.code, errorMessage: step.message });
      await event({ category: "payment", type: "payment.failed", severity: "critical", title: "Purchase stopped — not charged", detail: step.message, data: { code: step.code } });
    } else {
      await update(db, purchaseId, { stage: "needs_attention", paymentStatus: "unknown", failureCode: step.code, failureMessage: step.message });
      await upsertPayment(db, purchaseId, { status: "unknown", errorCode: step.code, errorMessage: step.message });
      await event({ category: "payment", type: "payment.unknown", severity: "warning", title: "Payment outcome needs checking", detail: step.message, data: { code: step.code } });
    }
    return summarise(db, purchaseId);
  }
}

async function markSettled(db: Database, purchaseId: string, txHash: string) {
  await update(db, purchaseId, { paymentStatus: "settled" });
  await upsertPayment(db, purchaseId, { status: "settled", txHash, settledAt: new Date() });
}

async function markConfirmed(db: Database, purchaseId: string, ledger: number) {
  await update(db, purchaseId, { paymentStatus: "confirmed" });
  await upsertPayment(db, purchaseId, { status: "confirmed", ledger, confirmedAt: new Date() });
}

async function recordSuccess(
  db: Database,
  purchase: PurchaseRow,
  rawReceipt: ProviderReceipt,
  expected: { txHash: string; payer: string; payTo: string; amountAtomic: bigint } | null,
  horizon: typeof confirmOnHorizon,
  event: (e: Omit<Parameters<typeof recordEvent>[1], "householdId" | "purchaseId" | "simTime">) => Promise<string>,
  replay: boolean,
): Promise<ExecuteResult> {
  const parsed = receiptSchema.safeParse(rawReceipt);
  if (!parsed.success || parsed.data.purchaseId !== purchase.id) {
    throw new StepError("invalid_receipt", "The provider returned a receipt that does not match this purchase.", "unknown");
  }
  const receipt = rawReceipt;
  const txHash = receipt.payment.txHash;
  if (expected && expected.txHash !== txHash) {
    throw new StepError("receipt_tx_mismatch", "The receipt's transaction does not match the settlement response.", "unknown");
  }

  await markSettled(db, purchase.id, txHash);
  await upsertPayment(db, purchase.id, { amountAtomic: receipt.payment.amountAtomic, asset: receipt.payment.asset, payer: receipt.payment.payer });
  await event({
    category: "payment",
    type: "payment.settled",
    severity: "info",
    title: replay ? "Existing settlement found — no new payment made" : "Facilitator settled the payment",
    detail: `Stellar testnet transaction ${txHash.slice(0, 10)}…`,
    data: { txHash, explorerUrl: explorerTxUrl(txHash) },
  });

  // Independent on-chain confirmation.
  const [pay] = await db.select().from(s.payments).where(eq(s.payments.purchaseId, purchase.id));
  const confirmation = await horizon({
    txHash,
    from: expected?.payer ?? pay?.payer ?? "",
    to: expected?.payTo ?? providerPayTo(purchase.kind),
    amountAtomic: expected?.amountAtomic ?? BigInt(receipt.payment.amountAtomic),
  });
  if (confirmation.status === "confirmed") {
    await markConfirmed(db, purchase.id, confirmation.ledger);
    await event({
      category: "payment",
      type: "payment.confirmed",
      severity: "success",
      title: "Payment confirmed on Stellar testnet",
      detail: `Verified on Horizon in ledger ${confirmation.ledger}: ${formatAtomic(receipt.payment.amountAtomic)} testnet USDC to ${receipt.provider.name}.`,
      data: { txHash, ledger: confirmation.ledger, explorerUrl: explorerTxUrl(txHash) },
    });
  } else {
    await event({
      category: "payment",
      type: "payment.confirmation_pending",
      severity: "warning",
      title: "Settlement reported, on-chain confirmation pending",
      detail: confirmation.status === "unreachable" ? confirmation.reason : `Horizon: ${confirmation.status}`,
    });
  }

  await db
    .insert(s.receipts)
    .values({ id: newId("rcp"), purchaseId: purchase.id, providerReceiptId: receipt.receiptId, payload: receipt })
    .onConflictDoUpdate({ target: s.receipts.purchaseId, set: { payload: receipt } });

  const fulfilled = receipt.fulfilment.status === "fulfilled";
  const confirmed = confirmation.status === "confirmed";
  const mismatch = confirmation.status === "mismatch" || confirmation.status === "failed_on_chain";
  await update(db, purchase.id, {
    fulfilmentStatus: fulfilled ? "fulfilled" : receipt.fulfilment.status === "failed" ? "failed" : "pending",
    stage: fulfilled && confirmed ? "completed" : "needs_attention",
    failureCode: mismatch ? "onchain_mismatch" : !confirmed ? "confirmation_pending" : !fulfilled ? "fulfilment_pending" : null,
    failureMessage: mismatch ? ("reason" in confirmation ? confirmation.reason : "Transaction failed on-chain.") : null,
    ...(mismatch ? { paymentStatus: "unknown" as const } : {}),
  });

  if (fulfilled && receipt.fulfilment.status === "fulfilled") {
    const f = receipt.fulfilment;
    await event({
      category: "fulfilment",
      type: "fulfilment.confirmed",
      severity: "success",
      title: `${receipt.provider.name} released ${f.quantity} ${f.unit}`,
      detail: `Simulated balance ${f.balanceBefore} → ${f.balanceAfter} ${f.unit}.${f.demoToken ? ` Demo token ${f.demoToken}.` : ""}`,
      data: { receiptId: receipt.receiptId },
    });
  }
  return summarise(db, purchase.id);
}

/**
 * Recovery for a purchase in `needs_attention`. Never signs or sends a new payment:
 * it asks the provider to (re-)release the utility for the settlement it already holds,
 * and re-checks the chain when the payment outcome is unknown.
 */
export async function recoverPurchase(db: Database, purchaseId: string, options: BuyerOptions = {}): Promise<ExecuteResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const horizon = options.horizon ?? confirmOnHorizon;
  const [purchase] = await db.select().from(s.purchases).where(eq(s.purchases.id, purchaseId));
  if (!purchase) throw new Error(`Purchase ${purchaseId} not found`);
  if (purchase.stage !== "needs_attention") return summarise(db, purchaseId);

  const [hh] = await db.select().from(s.households).where(eq(s.households.id, purchase.householdId));
  const event = (e: Omit<Parameters<typeof recordEvent>[1], "householdId" | "purchaseId" | "simTime">) =>
    recordEvent(db, { ...e, householdId: purchase.householdId, purchaseId, simTime: hh?.simulatedNow ?? new Date() });

  const url = new URL(`/api/providers/${purchase.kind}/fulfilment/retry`, env().APP_BASE_URL).toString();
  await event({ category: "fulfilment", type: "fulfilment.retry", severity: "info", title: "Retrying fulfilment — no new payment", detail: "Asking the provider to release the utility for the payment it already received." });
  let res: Response;
  try {
    res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purchaseId }), signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    await event({ category: "fulfilment", type: "fulfilment.retry_failed", severity: "warning", title: "Provider unreachable", detail: (err as Error).message });
    return summarise(db, purchaseId);
  }
  const body = await readBody(res);

  if (res.ok) {
    const [pay] = await db.select().from(s.payments).where(eq(s.payments.purchaseId, purchaseId));
    try {
      return await recordSuccess(
        db,
        purchase,
        body as ProviderReceipt,
        null,
        // Already confirmed earlier? Don't hit Horizon again.
        pay?.status === "confirmed" && pay.ledger
          ? async () => ({ status: "confirmed", ledger: pay.ledger!, closedAt: "", transferVerified: true })
          : horizon,
        event,
        true,
      );
    } catch (err) {
      await update(db, purchaseId, { failureCode: (err as { code?: string }).code ?? "invalid_receipt", failureMessage: (err as Error).message });
      return summarise(db, purchaseId);
    }
  }

  const code = (body as { code?: string } | null)?.code;
  if (res.status === 404 && code === "no_settlement" && purchase.paymentStatus === "unknown") {
    // The provider never recorded a settlement. Only conclude "not charged" once the signed
    // authorisation can no longer be submitted (requirements expired).
    const [pay] = await db.select().from(s.payments).where(eq(s.payments.purchaseId, purchaseId));
    const timeoutMs = ((pay?.paymentRequired as PaymentRequired | null)?.accepts[0]?.maxTimeoutSeconds ?? 300) * 1000;
    if (pay && Date.now() - pay.updatedAt.getTime() > timeoutMs) {
      await update(db, purchaseId, { stage: "failed", paymentStatus: "failed", failureCode: "not_settled", failureMessage: "The provider never settled this payment and the authorisation has expired. Nothing was charged." });
      await upsertPayment(db, purchaseId, { status: "failed", errorCode: "not_settled" });
      await event({ category: "payment", type: "payment.reconciled_failed", severity: "info", title: "Reconciled — not charged", detail: "The signed authorisation expired without settlement." });
    }
    return summarise(db, purchaseId);
  }

  await update(db, purchaseId, { failureCode: code ?? `http_${res.status}`, failureMessage: (body as { message?: string } | null)?.message ?? null });
  await event({ category: "fulfilment", type: "fulfilment.retry_failed", severity: "warning", title: "Fulfilment retry did not succeed", detail: (body as { message?: string } | null)?.message ?? `HTTP ${res.status}` });
  return summarise(db, purchaseId);
}

export async function summarise(db: Database, purchaseId: string): Promise<ExecuteResult> {
  const [p] = await db.select().from(s.purchases).where(eq(s.purchases.id, purchaseId));
  const [pay] = await db.select().from(s.payments).where(eq(s.payments.purchaseId, purchaseId));
  const [rcp] = await db.select().from(s.receipts).where(eq(s.receipts.purchaseId, purchaseId));
  if (!p) throw new Error(`Purchase ${purchaseId} not found`);
  return {
    purchaseId,
    stage: p.stage,
    paymentStatus: p.paymentStatus,
    fulfilmentStatus: p.fulfilmentStatus,
    txHash: pay?.txHash ?? null,
    explorerUrl: pay?.txHash ? explorerTxUrl(pay.txHash) : null,
    failureCode: p.failureCode,
    failureMessage: p.failureMessage,
    receipt: (rcp?.payload as ProviderReceipt | undefined) ?? null,
  };
}
