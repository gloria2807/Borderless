/**
 * Provider-specific release of SIMULATED utilities into the household's virtual devices.
 * Called only after the facilitator has settled the payment on Stellar testnet.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { newId } from "../lib/ids";
import type { Product } from "./catalog";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface FulfilmentContext {
  kind: UtilityKind;
  product: Product;
  accountId: string;
  txHash: string;
  simNow: Date;
}

export interface FulfilmentOutcome {
  balanceBefore: number;
  balanceAfter: number;
  demoToken: string | null;
  details: Record<string, unknown>;
}

/** 20-digit DEMO token derived from the settlement tx. Not valid on any physical meter. */
export function demoElectricityToken(txHash: string): string {
  const digest = createHash("sha256").update(`borderless-demo-token:${txHash}`).digest();
  let digits = "";
  for (const byte of digest) {
    digits += (byte % 10).toString();
    if (digits.length === 20) break;
  }
  return digits.match(/.{4}/g)!.join("-");
}

const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

export async function applyFulfilment(tx: Tx, ctx: FulfilmentContext): Promise<FulfilmentOutcome> {
  const [balance] = await tx.select().from(s.utilityBalances).where(eq(s.utilityBalances.accountId, ctx.accountId));
  if (!balance) throw new Error(`Virtual device for account ${ctx.accountId} not found`);
  if (balance.unit !== ctx.product.unit) throw new Error(`Unit mismatch: device ${balance.unit}, product ${ctx.product.unit}`);

  const before = balance.balance;
  const after = round(before + ctx.product.quantity);
  const update: Partial<typeof s.utilityBalances.$inferInsert> = { balance: after, updatedAt: new Date() };
  let demoToken: string | null = null;
  const details: Record<string, unknown> = { product: ctx.product.label, quantity: ctx.product.quantity, unit: ctx.product.unit };

  switch (ctx.kind) {
    case "electricity":
      demoToken = demoElectricityToken(ctx.txHash);
      details.tariffNote = "Demo tariff — not a real DisCo rate";
      break;
    case "airtime":
      details.rechargeType = "VTU (simulated)";
      break;
    case "data": {
      const validityHours = ctx.product.validityHours ?? 24 * 30;
      const expiresAt = new Date(ctx.simNow.getTime() + validityHours * 3_600_000);
      update.activeBundle = ctx.product.label;
      update.expiresAt = expiresAt;
      details.expiresAt = expiresAt.toISOString();
      details.validityHours = validityHours;
      break;
    }
  }

  await tx
    .update(s.utilityBalances)
    .set(update)
    .where(and(eq(s.utilityBalances.accountId, ctx.accountId), eq(s.utilityBalances.balance, before)));
  await tx.insert(s.usageRecords).values({
    id: newId("use"),
    accountId: ctx.accountId,
    simTime: ctx.simNow,
    delta: -ctx.product.quantity,
    balanceAfter: after,
    source: "purchase",
  });

  return { balanceBefore: before, balanceAfter: after, demoToken, details };
}
