/**
 * The owner's controls over Borderless: pause, resume and emergency stop.
 *
 * - Pause: Borderless stops working. No new runs or monitoring assessments; a running task stops
 *   at its next step; any purchase re-checks the pause in the policy engine before signing.
 * - Resume: Borderless may work again. It does not re-grant purchasing authority if the owner
 *   turned that off.
 * - Emergency stop: pause, revoke automatic purchasing, and decline every purchase waiting for
 *   approval, so nothing in flight can be paid.
 *
 * The agent has no tool that reaches these functions; only the owner's API does.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import * as s from "../db/schema";
import { declinePurchase } from "../transactions/approvals";
import { recordEvent } from "../transactions/events";

export type AgentControlAction = "pause" | "resume" | "emergency_stop";

export interface AgentControlState {
  paused: boolean;
  autoPurchaseEnabled: boolean;
  declinedApprovals: string[];
}

export async function agentControlState(db: Database, householdId: string): Promise<{ paused: boolean; autoPurchaseEnabled: boolean }> {
  const [p] = await db.select({ paused: s.agentPolicies.agentPaused, auto: s.agentPolicies.autoPurchaseEnabled }).from(s.agentPolicies).where(eq(s.agentPolicies.householdId, householdId));
  return { paused: !!p?.paused, autoPurchaseEnabled: !!p?.auto };
}

export async function controlAgent(db: Database, householdId: string, action: AgentControlAction): Promise<AgentControlState> {
  const [hh] = await db.select({ simNow: s.households.simulatedNow }).from(s.households).where(eq(s.households.id, householdId));
  if (!hh) throw new Error("Unknown household.");
  const simTime = hh.simNow;
  const declined: string[] = [];

  if (action === "pause" || action === "resume") {
    const paused = action === "pause";
    await db.update(s.agentPolicies).set({ agentPaused: paused, updatedAt: new Date() }).where(eq(s.agentPolicies.householdId, householdId));
    await recordEvent(db, {
      householdId,
      category: "system",
      type: paused ? "agent.paused" : "agent.resumed",
      severity: paused ? "warning" : "info",
      title: paused ? "Owner paused Borderless" : "Owner resumed Borderless",
      detail: paused ? "No assessments, runs or purchases until resumed. A task in progress stops at its next step." : "Borderless may monitor and act again, within the current spending rules.",
      simTime,
    });
  } else {
    await db.update(s.agentPolicies).set({ agentPaused: true, autoPurchaseEnabled: false, updatedAt: new Date() }).where(eq(s.agentPolicies.householdId, householdId));
    const waiting = await db
      .select({ id: s.purchases.id })
      .from(s.purchases)
      .where(and(eq(s.purchases.householdId, householdId), eq(s.purchases.stage, "awaiting_approval")));
    for (const p of waiting) {
      await declinePurchase(db, p.id);
      declined.push(p.id);
    }
    await recordEvent(db, {
      householdId,
      category: "system",
      type: "agent.emergency_stop",
      severity: "critical",
      title: "Emergency stop: Borderless paused and purchasing authority revoked",
      detail: `${declined.length ? `${declined.length} pending approval request${declined.length === 1 ? " was" : "s were"} declined unpaid. ` : ""}Resume Borderless and turn automatic purchasing back on in Settings to restore it.`,
      data: { declined },
      simTime,
    });
  }
  const state = await agentControlState(db, householdId);
  return { ...state, declinedApprovals: declined };
}
