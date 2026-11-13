/**
 * Utility Accounts: each household account, who can serve it, and its purchase record.
 * Server-only; built from the database and the provider registry.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { loadHousehold } from "../household/state";
import { providerPayTo, providersFor } from "../providers/registry";
import { forecast } from "../usage/forecast";
import { recentSamples } from "../usage/simulator";

export interface AccountProviderView {
  id: string;
  name: string;
  isDefault: boolean;
  available: boolean;
  approved: boolean;
  servesNetwork: boolean;
  offer: string;
  priceFromNgn: number;
  priceToNgn: number;
  products: number;
  payTo: string | null;
}

export interface UtilityAccountView {
  id: string;
  kind: UtilityKind;
  label: string;
  identifier: string;
  network: string | null;
  balance: number;
  unit: string;
  hoursRemaining: number | null;
  urgency: string;
  confidence: string;
  providers: AccountProviderView[];
  stats: { completed: number; spentNgn: number; failed: number; lastAt: string | null; lastLabel: string | null; lastPurchaseId: string | null };
}

export async function getUtilityAccounts(householdId: string): Promise<UtilityAccountView[]> {
  const database = db();
  const state = await loadHousehold(database, householdId);
  const now = state.household.simulatedNow;
  const rows = await database
    .select({ account: s.utilityAccounts, balance: s.utilityBalances })
    .from(s.utilityAccounts)
    .innerJoin(s.utilityBalances, eq(s.utilityBalances.accountId, s.utilityAccounts.id))
    .where(eq(s.utilityAccounts.householdId, householdId));
  const providerRows = await database.select().from(s.utilityProviders);
  const purchases = await database
    .select()
    .from(s.purchases)
    .where(and(eq(s.purchases.householdId, householdId), inArray(s.purchases.accountId, rows.map((r) => r.account.id))))
    .orderBy(desc(s.purchases.createdAt));

  const order: UtilityKind[] = ["electricity", "airtime", "data"];
  const out: UtilityAccountView[] = [];
  for (const { account, balance } of rows.sort((a, b) => order.indexOf(a.account.kind) - order.indexOf(b.account.kind))) {
    const f = forecast({ kind: account.kind, balance: balance.balance, unit: balance.unit, baselinePerHour: balance.baselineUsagePerHour, expiresAt: balance.expiresAt }, await recentSamples(database, account.id, now), now);
    const mine = purchases.filter((p) => p.accountId === account.id);
    const completed = mine.filter((p) => p.stage === "completed");
    const last = completed[0];
    out.push({
      id: account.id,
      kind: account.kind,
      label: account.label,
      identifier: account.identifier,
      network: account.network,
      balance: balance.balance,
      unit: balance.unit,
      hoursRemaining: Number.isFinite(f.hoursRemaining) ? Math.round(f.hoursRemaining * 10) / 10 : null,
      urgency: f.urgency,
      confidence: f.confidence.level,
      providers: providersFor(account.kind).map((m) => {
        const prices = m.listProducts().map((p) => p.amountNgn);
        let payTo: string | null = null;
        try {
          payTo = providerPayTo(m.definition.id);
        } catch {
          payTo = null;
        }
        return {
          id: m.definition.id,
          name: m.definition.name,
          isDefault: m.definition.id === account.providerId,
          available: providerRows.find((r) => r.id === m.definition.id)?.available ?? false,
          approved: state.policy.approvedProviderIds.includes(m.definition.id),
          servesNetwork: account.kind === "electricity" || (account.network !== null && m.definition.networks.includes(account.network)),
          offer: m.definition.offerSummary,
          priceFromNgn: Math.min(...prices),
          priceToNgn: Math.max(...prices),
          products: prices.length,
          payTo,
        };
      }),
      stats: {
        completed: completed.length,
        spentNgn: completed.reduce((t, p) => t + p.amountNgn, 0),
        failed: mine.filter((p) => p.stage === "failed").length,
        lastAt: last?.simTime.toISOString() ?? null,
        lastLabel: last ? `${last.productCode}` : null,
        lastPurchaseId: last?.id ?? null,
      },
    });
  }
  return out;
}
