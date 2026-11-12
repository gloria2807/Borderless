/**
 * Deterministic usage simulator. DEMO DATA ONLY — no real household telemetry.
 *
 * Advances the household's simulated clock hour by hour, draining each virtual
 * device by baseline × operator multiplier × a fixed time-of-day profile.
 * No randomness: the same starting state and the same steps always produce the
 * same balances, so the judging demo is reproducible.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import type { UtilityKind } from "../db/schema";
import { newId } from "../lib/ids";
import { recordEvent } from "../transactions/events";

const HOUR = 3_600_000;
/** Nigeria is UTC+1 (WAT) all year. */
const WAT_OFFSET_HOURS = 1;
export const MAX_ADVANCE_HOURS = 24 * 14;

/** Relative consumption by local hour (0–23). Each profile averages ≈ 1.0 over a day. */
const PROFILES: Record<UtilityKind, (hour: number) => number> = {
  electricity: (h) => (h < 6 ? 0.6 : h < 9 ? 1.2 : h < 18 ? 0.8 : h < 23 ? 1.6 : 1.0),
  data: (h) => (h < 7 ? 0.3 : h < 18 ? 1.2 : 1.5),
  airtime: () => 1,
};

export function localHour(t: Date): number {
  return (t.getUTCHours() + WAT_OFFSET_HOURS) % 24;
}

export function hourlyConsumption(kind: UtilityKind, baselinePerHour: number, multiplier: number, at: Date): number {
  return baselinePerHour * multiplier * PROFILES[kind](localHour(at));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface AdvanceResult {
  from: Date;
  to: Date;
  hours: number;
  consumed: Record<string, number>;
  expiredBundles: string[];
}

export async function advanceTime(db: Database, householdId: string, hours: number): Promise<AdvanceResult> {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_ADVANCE_HOURS) {
    throw new Error(`hours must be an integer between 1 and ${MAX_ADVANCE_HOURS}`);
  }
  return db.transaction(
    async (tx) => {
      const [household] = await tx.select().from(s.households).where(eq(s.households.id, householdId));
      if (!household) throw new Error(`Household ${householdId} not found`);
      const rows = await tx
        .select({ account: s.utilityAccounts, balance: s.utilityBalances })
        .from(s.utilityAccounts)
        .innerJoin(s.utilityBalances, eq(s.utilityBalances.accountId, s.utilityAccounts.id))
        .where(eq(s.utilityAccounts.householdId, householdId));

      const from = household.simulatedNow;
      const consumed: Record<string, number> = {};
      const expiredBundles: string[] = [];
      const records: (typeof s.usageRecords.$inferInsert)[] = [];

      for (const { account, balance } of rows) {
        let current = balance.balance;
        let expiresAt = balance.expiresAt;
        let activeBundle = balance.activeBundle;
        consumed[account.kind] = 0;

        for (let step = 1; step <= hours; step += 1) {
          const at = new Date(from.getTime() + step * HOUR);
          // Data bundle expiry: any remaining data is forfeited.
          if (expiresAt && expiresAt.getTime() <= at.getTime() && current > 0) {
            records.push({ id: newId("use"), accountId: account.id, simTime: expiresAt, delta: round3(current), balanceAfter: 0, source: "expiry" });
            expiredBundles.push(`${activeBundle ?? "Data bundle"} expired with ${round3(current)} ${balance.unit} unused`);
            current = 0;
            activeBundle = null;
            continue;
          }
          if (current <= 0) continue;
          const use = Math.min(current, hourlyConsumption(account.kind, balance.baselineUsagePerHour, balance.usageMultiplier, at));
          current = round3(current - use);
          consumed[account.kind] = round3(consumed[account.kind]! + use);
          records.push({ id: newId("use"), accountId: account.id, simTime: at, delta: round3(use), balanceAfter: current, source: "simulation" });
        }

        await tx
          .update(s.utilityBalances)
          .set({ balance: current, activeBundle, expiresAt, updatedAt: new Date() })
          .where(eq(s.utilityBalances.accountId, account.id));
      }

      for (let i = 0; i < records.length; i += 200) await tx.insert(s.usageRecords).values(records.slice(i, i + 200));
      const to = new Date(from.getTime() + hours * HOUR);
      await tx.update(s.households).set({ simulatedNow: to, updatedAt: new Date() }).where(eq(s.households.id, householdId));

      await recordEvent(tx, {
        householdId,
        category: "system",
        type: "simulation.advanced",
        severity: "info",
        title: `Simulated ${hours} hour${hours === 1 ? "" : "s"} of household usage`,
        detail: Object.entries(consumed)
          .map(([k, v]) => `${k}: −${v} ${rows.find((r) => r.account.kind === k)?.balance.unit ?? ""}`)
          .join(" · "),
        data: { from: from.toISOString(), to: to.toISOString(), consumed },
        simTime: to,
      });
      for (const note of expiredBundles) {
        await recordEvent(tx, { householdId, category: "observation", type: "data.bundle_expired", severity: "warning", title: "Data bundle expired", detail: note, simTime: to });
      }
      return { from, to, hours, consumed, expiredBundles };
    },
    { behavior: "immediate" },
  );
}

/** Operator control: make a device consume faster or slower (e.g. 3 = heavy streaming). */
export async function setUsageMultiplier(db: Database, householdId: string, kind: UtilityKind, multiplier: number): Promise<void> {
  if (!(multiplier >= 0 && multiplier <= 10)) throw new Error("multiplier must be between 0 and 10");
  const [account] = await db
    .select()
    .from(s.utilityAccounts)
    .where(and(eq(s.utilityAccounts.householdId, householdId), eq(s.utilityAccounts.kind, kind)));
  if (!account) throw new Error(`No ${kind} account`);
  await db.update(s.utilityBalances).set({ usageMultiplier: multiplier, updatedAt: new Date() }).where(eq(s.utilityBalances.accountId, account.id));
}

/** Recent usage samples per account, for forecasting. */
export async function recentSamples(db: Database, accountId: string, now: Date, hours = 24) {
  return db
    .select({ simTime: s.usageRecords.simTime, delta: s.usageRecords.delta })
    .from(s.usageRecords)
    .where(
      and(
        eq(s.usageRecords.accountId, accountId),
        gt(s.usageRecords.simTime, new Date(now.getTime() - hours * HOUR)),
        inArray(s.usageRecords.source, ["simulation", "seed"]),
      ),
    );
}
