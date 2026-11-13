/**
 * Borderless persistent data model.
 *
 * SQLite (libsql) for the local demo. Types are deliberately portable: text ids,
 * integer epoch-ms timestamps, integer kobo/atomic amounts, JSON stored as text.
 * Moving to Postgres means swapping `sqlite-core` for `pg-core`; no semantics rely
 * on SQLite-specific behaviour.
 *
 * Money conventions
 *  - NGN amounts are stored as integer **naira** (household budgets are whole naira).
 *  - Testnet asset amounts are stored as integer **atomic units** in text (i128-safe).
 *  - Utility quantities (kWh, MB, NGN airtime) are stored as real numbers.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const UTILITY_KINDS = ["electricity", "airtime", "data"] as const;
export type UtilityKind = (typeof UTILITY_KINDS)[number];

export const MOBILE_NETWORKS = ["mtn", "airtel", "glo", "t2"] as const;
export type MobileNetwork = (typeof MOBILE_NETWORKS)[number];

/** Overall purchase lifecycle stage. Payment and fulfilment truth live in their own columns. */
export const PURCHASE_STAGES = [
  "awaiting_approval", // policy requires the owner to approve before any request is made
  "requested", // purchase request about to be / being sent to provider
  "payment_required", // provider answered HTTP 402; requirements captured
  "submitted", // signed payment sent to provider; awaiting verify + settle
  "completed", // payment confirmed AND fulfilment confirmed
  "needs_attention", // payment confirmed but fulfilment failed/pending — recoverable without re-paying
  "failed", // nothing was charged
  "cancelled", // owner declined / revoked before payment
] as const;
export type PurchaseStage = (typeof PURCHASE_STAGES)[number];

export const PAYMENT_STATUSES = [
  "not_started",
  "requires_payment", // 402 received
  "submitted", // PAYMENT-SIGNATURE sent
  "settled", // facilitator reported success with tx hash
  "confirmed", // tx independently confirmed on Horizon
  "failed", // definitively not charged
  "unknown", // outcome indeterminate (e.g. network drop after submit) — must reconcile, never re-pay blindly
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FULFILMENT_STATUSES = ["not_started", "pending", "fulfilled", "failed"] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

const id = () => text("id").primaryKey();
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

// ─── Household ────────────────────────────────────────────────────────────────

export const households = sqliteTable("households", {
  id: id(),
  name: text("name").notNull(),
  countryCode: text("country_code").notNull().default("NG"),
  currency: text("currency").notNull().default("NGN"),
  /** Simulated clock (epoch ms). All usage/forecasting uses this, never wall time. */
  simulatedNow: integer("simulated_now", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const householdMembers = sqliteTable("household_members", {
  id: id(),
  householdId: text("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
  createdAt: createdAt(),
});

export const householdBudgets = sqliteTable(
  "household_budgets",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    period: text("period", { enum: ["weekly", "monthly"] }).notNull(),
    amountNgn: integer("amount_ngn").notNull(),
    periodStart: integer("period_start", { mode: "timestamp_ms" }).notNull(),
    periodEnd: integer("period_end", { mode: "timestamp_ms" }).notNull(),
    /** Spend recorded before Borderless managed the household (demo seed), counts against budget. */
    priorSpendNgn: integer("prior_spend_ngn").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("budgets_household_idx").on(t.householdId, t.active)],
);

/** The owner-granted spending authority. Enforced in backend code before any signing. */
export const agentPolicies = sqliteTable("agent_policies", {
  householdId: text("household_id")
    .primaryKey()
    .references(() => households.id, { onDelete: "cascade" }),
  autoPurchaseEnabled: integer("auto_purchase_enabled", { mode: "boolean" }).notNull(),
  perPurchaseLimitNgn: integer("per_purchase_limit_ngn").notNull(),
  /** Most the agent may spend in one simulated day, across all runs. */
  dailyAgentBudgetNgn: integer("daily_agent_budget_ngn").notNull().default(8_000),
  /** Most a single agent run (task) may spend. */
  taskBudgetNgn: integer("task_budget_ngn").notNull().default(6_000),
  /** Budget the agent must always leave untouched. */
  reserveNgn: integer("reserve_ngn").notNull().default(0),
  /** Most the agent may pay for one information service (e.g. a meter diagnostic). */
  intelligenceCapNgn: integer("intelligence_cap_ngn").notNull().default(1000),
  /** Optional per-utility ceiling for a single purchase. JSON Partial<Record<UtilityKind, number>>. */
  maxPerUtilityNgn: text("max_per_utility_ngn", { mode: "json" }).$type<Partial<Record<UtilityKind, number>>>().notNull().default({}),
  /** How long an owner approval request stays open before it lapses (no answer = declined). */
  approvalTtlSeconds: integer("approval_ttl_seconds").notNull().default(180),
  /** Hard ceiling on everything the agent may spend within the active budget period. */
  overallAgentLimitNgn: integer("overall_agent_limit_ngn").notNull(),
  /** Purchases strictly above this amount require explicit owner approval. */
  manualApprovalThresholdNgn: integer("manual_approval_threshold_ngn").notNull(),
  /** Ordered list of utility kinds, most important first. JSON UtilityKind[]. */
  priorities: text("priorities", { mode: "json" }).$type<UtilityKind[]>().notNull(),
  approvedServices: text("approved_services", { mode: "json" }).$type<UtilityKind[]>().notNull(),
  approvedNetworks: text("approved_networks", { mode: "json" }).$type<MobileNetwork[]>().notNull(),
  approvedProviderIds: text("approved_provider_ids", { mode: "json" }).$type<string[]>().notNull(),
  updatedAt: updatedAt(),
});

// ─── Utilities ────────────────────────────────────────────────────────────────

export const PROVIDER_CATEGORIES = ["utility", "intelligence"] as const;
export const SERVICE_TYPES = ["utility_topup", "meter_diagnostic"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const utilityProviders = sqliteTable("utility_providers", {
  id: id(),
  /** What the provider sells: utility credit, or information that helps the agent decide. */
  category: text("category", { enum: PROVIDER_CATEGORIES }).notNull().default("utility"),
  kind: text("kind", { enum: UTILITY_KINDS }).notNull(),
  name: text("name").notNull(),
  countryCode: text("country_code").notNull(),
  /** Networks this provider can serve (mobile only). JSON MobileNetwork[]. */
  networks: text("networks", { mode: "json" }).$type<MobileNetwork[]>().notNull(),
  minAmountNgn: integer("min_amount_ngn").notNull(),
  maxAmountNgn: integer("max_amount_ngn").notNull(),
  /** Demo availability switch — lets the operator simulate a provider outage. */
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
});

export const utilityAccounts = sqliteTable(
  "utility_accounts",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: UTILITY_KINDS }).notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => utilityProviders.id),
    label: text("label").notNull(),
    /** Meter number or MSISDN. */
    identifier: text("identifier").notNull(),
    network: text("network", { enum: MOBILE_NETWORKS }),
    createdAt: createdAt(),
  },
  (t) => [
    index("accounts_household_idx").on(t.householdId),
    uniqueIndex("accounts_kind_identifier_uq").on(t.kind, t.identifier),
  ],
);

/** Current simulated balance of a virtual device. One row per account. */
export const utilityBalances = sqliteTable("utility_balances", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => utilityAccounts.id, { onDelete: "cascade" }),
  balance: real("balance").notNull(),
  unit: text("unit", { enum: ["kWh", "NGN", "MB"] }).notNull(),
  /** Baseline consumption per simulated hour, used by the simulator and forecasts. */
  baselineUsagePerHour: real("baseline_usage_per_hour").notNull(),
  /** Current multiplier applied by the simulator (e.g. 3 = unusually heavy usage). */
  usageMultiplier: real("usage_multiplier").notNull().default(1),
  /** Data bundle expiry (simulated time), if any. */
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  activeBundle: text("active_bundle"),
  updatedAt: updatedAt(),
});

export const usageRecords = sqliteTable(
  "usage_records",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => utilityAccounts.id, { onDelete: "cascade" }),
    simTime: integer("sim_time", { mode: "timestamp_ms" }).notNull(),
    /** Positive = consumed, negative = credited by a purchase. */
    delta: real("delta").notNull(),
    balanceAfter: real("balance_after").notNull(),
    source: text("source", { enum: ["simulation", "purchase", "seed", "expiry"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("usage_account_time_idx").on(t.accountId, t.simTime)],
);

// ─── Agent ────────────────────────────────────────────────────────────────────

export const agentDecisions = sqliteTable(
  "agent_decisions",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    simTime: integer("sim_time", { mode: "timestamp_ms" }).notNull(),
    trigger: text("trigger", { enum: ["tick", "manual", "scenario"] }).notNull(),
    inputSnapshot: text("input_snapshot", { mode: "json" }).notNull(),
    shortages: text("shortages", { mode: "json" }).notNull(),
    urgency: text("urgency", { mode: "json" }).notNull(),
    candidates: text("candidates", { mode: "json" }).notNull(),
    selectedAction: text("selected_action", { mode: "json" }).notNull(),
    reasoning: text("reasoning").notNull(),
    budgetImpact: text("budget_impact", { mode: "json" }).notNull(),
    outcome: text("outcome", {
      enum: ["no_action", "purchase_started", "awaiting_approval", "blocked", "flagged"],
    }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("decisions_household_idx").on(t.householdId, t.createdAt)],
);

// ─── Purchases, payments, fulfilment ─────────────────────────────────────────

export const purchases = sqliteTable(
  "purchases",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    decisionId: text("decision_id").references(() => agentDecisions.id),
    /** The agent run that made this purchase, if any. */
    runId: text("run_id").references(() => agentRuns.id),
    /** Provider-issued quote this purchase is bound to (buyer's copy of the commitment). */
    quoteId: text("quote_id"),
    quoteAmountAtomic: text("quote_amount_atomic"),
    quotePayTo: text("quote_pay_to"),
    quoteExpiresAt: integer("quote_expires_at", { mode: "timestamp_ms" }),
    /** Wall-clock deadline for the owner to approve a parked purchase (then it expires, unpaid). */
    approvalExpiresAt: integer("approval_expires_at", { mode: "timestamp_ms" }),
    /** Exact terms the owner is asked to approve, and their SHA-256 (approval binding). */
    approvalTerms: text("approval_terms", { mode: "json" }).$type<import("../transactions/approval-terms").ApprovalTerms>(),
    approvalTermsHash: text("approval_terms_hash"),
    accountId: text("account_id")
      .notNull()
      .references(() => utilityAccounts.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => utilityProviders.id),
    kind: text("kind", { enum: UTILITY_KINDS }).notNull(),
    productCode: text("product_code").notNull(),
    /** What is bought: utility credit, or an information service about the utility. */
    serviceType: text("service_type", { enum: SERVICE_TYPES }).notNull().default("utility_topup"),
    amountNgn: integer("amount_ngn").notNull(),
    quantity: real("quantity").notNull(),
    unit: text("unit", { enum: ["kWh", "NGN", "MB", "report"] }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    initiatedBy: text("initiated_by", { enum: ["agent", "owner", "script"] }).notNull(),
    stage: text("stage", { enum: PURCHASE_STAGES }).notNull(),
    paymentStatus: text("payment_status", { enum: PAYMENT_STATUSES }).notNull(),
    fulfilmentStatus: text("fulfilment_status", { enum: FULFILMENT_STATUSES }).notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    /** Simulated household time the purchase was created at — budget periods are evaluated on this. */
    simTime: integer("sim_time", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("purchases_idempotency_uq").on(t.idempotencyKey),
    index("purchases_household_sim_idx").on(t.householdId, t.simTime),
    index("purchases_household_idx").on(t.householdId, t.createdAt),
    index("purchases_account_stage_idx").on(t.accountId, t.stage),
  ],
);

/** Buyer-side record of the x402 payment. */
export const payments = sqliteTable(
  "payments",
  {
    id: id(),
    purchaseId: text("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    network: text("network").notNull(),
    scheme: text("scheme"),
    asset: text("asset"),
    assetCode: text("asset_code").notNull().default("USDC"),
    amountAtomic: text("amount_atomic"),
    decimals: integer("decimals").notNull().default(7),
    payTo: text("pay_to"),
    payer: text("payer"),
    status: text("status", { enum: PAYMENT_STATUSES }).notNull(),
    paymentRequired: text("payment_required", { mode: "json" }),
    settleResponse: text("settle_response", { mode: "json" }),
    txHash: text("tx_hash"),
    ledger: integer("ledger"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("payments_purchase_uq").on(t.purchaseId),
    uniqueIndex("payments_tx_hash_uq").on(t.txHash),
  ],
);

/**
 * Provider-side ledger. Owned by the provider module, not the household.
 * A settled transaction can be fulfilled exactly once (unique tx hash and purchase id).
 */
export const providerSettlements = sqliteTable(
  "provider_settlements",
  {
    id: id(),
    providerId: text("provider_id")
      .notNull()
      .references(() => utilityProviders.id),
    purchaseId: text("purchase_id").notNull(),
    txHash: text("tx_hash").notNull(),
    payer: text("payer"),
    amountAtomic: text("amount_atomic").notNull(),
    asset: text("asset").notNull(),
    network: text("network").notNull(),
    /** The request this payment bought (validated at settle time). JSON ProviderOrder. */
    order: text("order", { mode: "json" }).notNull(),
    fulfilmentStatus: text("fulfilment_status", { enum: ["pending", "fulfilled", "failed"] }).notNull(),
    fulfilmentAttempts: integer("fulfilment_attempts").notNull().default(0),
    lastError: text("last_error"),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("settlements_tx_uq").on(t.txHash),
    uniqueIndex("settlements_provider_purchase_uq").on(t.providerId, t.purchaseId),
  ],
);

/**
 * Provider-side quotes. A quote fixes product, recipient, NGN price, testnet USDC price and
 * payee for a short time; the provider's x402 price for a purchase comes from its quote.
 * A quote can be redeemed by exactly one purchase.
 */
export const providerQuotes = sqliteTable(
  "provider_quotes",
  {
    id: id(),
    providerId: text("provider_id")
      .notNull()
      .references(() => utilityProviders.id),
    accountIdentifier: text("account_identifier").notNull(),
    network: text("network", { enum: MOBILE_NETWORKS }),
    productCode: text("product_code").notNull(),
    amountNgn: integer("amount_ngn").notNull(),
    quantity: real("quantity").notNull(),
    unit: text("unit", { enum: ["kWh", "NGN", "MB", "report"] }).notNull(),
    amountAtomic: text("amount_atomic").notNull(),
    asset: text("asset").notNull(),
    payTo: text("pay_to").notNull(),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** Set when a settled purchase redeems the quote. */
    redeemedByPurchaseId: text("redeemed_by_purchase_id"),
  },
  (t) => [uniqueIndex("quotes_redeemed_uq").on(t.redeemedByPurchaseId)],
);

export const fulfilments = sqliteTable(
  "fulfilments",
  {
    id: id(),
    purchaseId: text("purchase_id").notNull(),
    settlementId: text("settlement_id")
      .notNull()
      .references(() => providerSettlements.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => utilityProviders.id),
    accountId: text("account_id")
      .notNull()
      .references(() => utilityAccounts.id),
    quantity: real("quantity").notNull(),
    unit: text("unit", { enum: ["kWh", "NGN", "MB", "report"] }).notNull(),
    balanceBefore: real("balance_before").notNull(),
    balanceAfter: real("balance_after").notNull(),
    /** Demo artefact (e.g. a 20-digit demo electricity token). Never valid on a real meter. */
    demoToken: text("demo_token"),
    details: text("details", { mode: "json" }),
    fulfilledAt: integer("fulfilled_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fulfilments_settlement_uq").on(t.settlementId),
    uniqueIndex("fulfilments_purchase_uq").on(t.purchaseId),
  ],
);

/** Buyer-side copy of the provider's structured receipt. */
export const receipts = sqliteTable(
  "receipts",
  {
    id: id(),
    purchaseId: text("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    providerReceiptId: text("provider_receipt_id").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("receipts_purchase_uq").on(t.purchaseId)],
);

// ─── Timeline & demo ─────────────────────────────────────────────────────────

// ─── Agent runs ──────────────────────────────────────────────────────────────

export const AGENT_RUN_STATUSES = ["running", "completed", "failed", "interrupted"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** One execution of the agent on a task. Persisted so history survives refresh and restart. */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    /** "ai" = language-model planner; "deterministic" = rule-based planner (no AI). */
    mode: text("mode", { enum: ["ai", "deterministic"] }).notNull(),
    model: text("model"),
    task: text("task").notNull(),
    trigger: text("trigger", { enum: ["manual", "tick", "scenario"] }).notNull(),
    status: text("status", { enum: AGENT_RUN_STATUSES }).notNull(),
    summary: text("summary"),
    error: text("error"),
    steps: integer("steps").notNull().default(0),
    /** Token usage reported by the model provider. JSON. */
    usage: text("usage", { mode: "json" }),
    simTime: integer("sim_time", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("runs_household_idx").on(t.householdId, t.startedAt)],
);

/** Execution stages shown in Agent Operations. Recorded by the backend as they happen. */
export const RUN_STAGES = [
  "planning",
  "observing",
  "analysing",
  "discovering",
  "comparing",
  "deciding",
  "requesting_payment",
  "checking_policy",
  "awaiting_approval",
  "signing",
  "settling",
  "verifying_fulfilment",
  "updating_household",
  "reassessing",
  "finished",
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

/** Append-only, ordered log of what happened during a run. Never edited after insert. */
export const agentRunEvents = sqliteTable(
  "agent_run_events",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    stage: text("stage", { enum: RUN_STAGES }).notNull(),
    /** e.g. run.started, model.message, tool.called, tool.result, policy.evaluated, payment.*, run.finished */
    type: text("type").notNull(),
    utility: text("utility", { enum: UTILITY_KINDS }),
    tool: text("tool"),
    input: text("input", { mode: "json" }),
    result: text("result", { mode: "json" }),
    decision: text("decision"),
    reason: text("reason"),
    paymentStatus: text("payment_status"),
    txHash: text("tx_hash"),
    purchaseId: text("purchase_id"),
    error: text("error"),
  },
  (t) => [uniqueIndex("run_events_seq_uq").on(t.runId, t.seq)],
);

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    purchaseId: text("purchase_id"),
    decisionId: text("decision_id"),
    /** observation | prediction | decision | payment | fulfilment | system */
    category: text("category", {
      enum: ["observation", "prediction", "decision", "payment", "fulfilment", "system"],
    }).notNull(),
    type: text("type").notNull(),
    severity: text("severity", { enum: ["info", "success", "warning", "critical"] }).notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    data: text("data", { mode: "json" }),
    simTime: integer("sim_time", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("events_household_idx").on(t.householdId, t.createdAt),
    index("events_purchase_idx").on(t.purchaseId),
  ],
);

export const demoScenarios = sqliteTable("demo_scenarios", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  createdAt: createdAt(),
});

/** Server-side demo fault injection switches (testing failure paths honestly). */
export const demoFaults = sqliteTable("demo_faults", {
  key: text("key").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  updatedAt: updatedAt(),
});

/**
 * Funding guard: the household treasury's on-chain allowance to the agent wallet
 * (USDC Stellar Asset Contract `approve`). Stellar enforces the cap and expiry; this row
 * records what was granted so the UI can show it. The amount left is read on-chain.
 */
export const fundingGuards = sqliteTable("funding_guards", {
  householdId: text("household_id")
    .primaryKey()
    .references(() => households.id),
  treasury: text("treasury").notNull(),
  spender: text("spender").notNull(),
  capAtomic: text("cap_atomic").notNull(),
  expirationLedger: integer("expiration_ledger").notNull(),
  grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
  grantTxHash: text("grant_tx_hash").notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  revokeTxHash: text("revoke_tx_hash"),
  updatedAt: updatedAt(),
});

/**
 * PROVIDER-SIDE ground truth for the simulated smart meter (what is really drawing power).
 * Only diagnostic providers read this, and only after they are paid — agent tools never
 * do (a test enforces it). The household's free view is hourly meter totals.
 */
export const METER_PROFILES = ["stuck_water_heater", "extra_occupancy", "meter_overreading"] as const;
export type MeterProfile = (typeof METER_PROFILES)[number];

export const meterProfiles = sqliteTable("meter_profiles", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => utilityAccounts.id, { onDelete: "cascade" }),
  profile: text("profile", { enum: METER_PROFILES }).notNull(),
  /** Extra load (kWh per hour) the profile adds, or the share the meter over-reads. */
  magnitude: real("magnitude").notNull(),
  since: integer("since", { mode: "timestamp_ms" }).notNull(),
});
