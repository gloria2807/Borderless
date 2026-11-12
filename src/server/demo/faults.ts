/**
 * Demo fault injection — lets the operator exercise failure paths honestly
 * (e.g. "provider fails after payment") without faking any payment outcome.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { demoFaults } from "../db/schema";

export const DEMO_FAULTS = {
  provider_fulfilment_failure: "Provider fails to release the utility after a successful payment",
} as const;
export type DemoFaultKey = keyof typeof DEMO_FAULTS;

export async function isFaultEnabled(key: DemoFaultKey): Promise<boolean> {
  const [row] = await db().select().from(demoFaults).where(eq(demoFaults.key, key));
  return row?.enabled ?? false;
}

export async function setFault(key: DemoFaultKey, enabled: boolean): Promise<void> {
  await db()
    .insert(demoFaults)
    .values({ key, enabled })
    .onConflictDoUpdate({ target: demoFaults.key, set: { enabled, updatedAt: new Date() } });
}
