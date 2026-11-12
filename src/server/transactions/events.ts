import type { Database } from "../db/client";
import { activityEvents } from "../db/schema";
import { newId } from "../lib/ids";

type EventInsert = typeof activityEvents.$inferInsert;
type Executor = Pick<Database, "insert">;

export interface EventInput {
  householdId: string;
  category: EventInsert["category"];
  type: string;
  severity: EventInsert["severity"];
  title: string;
  detail?: string;
  data?: unknown;
  purchaseId?: string;
  decisionId?: string;
  simTime: Date;
}

/** Append-only activity timeline entry. */
export async function recordEvent(db: Executor, e: EventInput): Promise<string> {
  const id = newId("evt");
  await db.insert(activityEvents).values({ id, ...e, data: e.data ?? null });
  return id;
}
