import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_HOUSEHOLD_ID } from "@/server/household/seed";
import { createPurchase } from "@/server/transactions/purchases";
import { STALE_AFTER_MS, sweepInterruptedPurchases } from "@/server/transactions/sweep";
import { configureTestEnv, freshDatabase } from "./helpers";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

const later = () => Date.now() + STALE_AFTER_MS + 1_000;
const get = async (id: string) => (await database.select().from(s.purchases).where(eq(s.purchases.id, id)))[0]!;

describe("interrupted purchase sweep", () => {
  it("closes purchases interrupted before any payment was sent as not charged", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 1_000, initiatedBy: "agent" });
    await database.update(s.purchases).set({ stage: "payment_required", paymentStatus: "requires_payment" }).where(eq(s.purchases.id, p.id));
    expect(await sweepInterruptedPurchases(database, DEMO_HOUSEHOLD_ID, later())).toBe(1);
    expect(await get(p.id)).toMatchObject({ stage: "failed", paymentStatus: "failed", failureCode: "interrupted" });
    // The utility is free again for a new purchase.
    await expect(createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 1_000, initiatedBy: "agent" })).resolves.toBeDefined();
  });

  it("never fails a purchase whose payment may have been sent — it is reconciled instead", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "data", productCode: "data_750mb_7d", initiatedBy: "agent" });
    await database.update(s.purchases).set({ stage: "submitted", paymentStatus: "submitted" }).where(eq(s.purchases.id, p.id));
    await sweepInterruptedPurchases(database, DEMO_HOUSEHOLD_ID, later());
    expect(await get(p.id)).toMatchObject({ stage: "needs_attention", paymentStatus: "unknown", failureCode: "interrupted_after_submit" });
  });

  it("leaves recent in-flight purchases alone", async () => {
    const p = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "airtime", amountNgn: 500, initiatedBy: "agent" });
    expect(await sweepInterruptedPurchases(database, DEMO_HOUSEHOLD_ID)).toBe(0);
    expect((await get(p.id)).stage).toBe("requested");
  });
});
