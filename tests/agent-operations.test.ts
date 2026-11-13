/**
 * Agent Operations (upgrade M5). Proves:
 *  - the SSE stream replays the persisted run log in order, resumes after Last-Event-ID
 *    without duplicates, forwards live events, and ends when the run ends;
 *  - parked purchases carry an approval deadline and expire unpaid;
 *  - owner decisions on a run's purchase are written into that run's log;
 *  - the run read model shows the run's purchases and events.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as streamRoute } from "@/app/api/agent/runs/[id]/events/route";
import { POST as purchaseAction } from "@/app/api/purchases/[id]/[action]/route";
import { startAgentRun } from "@/server/agent/runtime/executor";
import { appendRunEvent, createRun, finishRun, listRunEvents } from "@/server/agent/runtime/run-log";
import type { Database } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { DEMO_HOUSEHOLD_ID, resetDemo } from "@/server/household/seed";
import { approvePurchase, ApprovalExpiredError, declinePurchase, expireApprovals } from "@/server/transactions/approvals";
import { createPurchase, PolicyDeniedError } from "@/server/transactions/purchases";
import { sweepInterruptedPurchases } from "@/server/transactions/sweep";
import { getRunView } from "@/server/views/runs";
import { configureTestEnv, freshDatabase } from "./helpers";
import { providerFetch } from "./provider-fetch";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

type Sse = { event: string; id: number | null; data: Record<string, unknown> };

/** Read an SSE response until it closes (or `max` ms pass). */
async function readSse(res: Response, max = 10_000): Promise<Sse[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Sse[] = [];
  const deadline = Date.now() + max;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now()))]);
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      if (!event) continue;
      const id = /^id: (.*)$/m.exec(block)?.[1];
      out.push({ event, id: id ? Number(id) : null, data: JSON.parse(/^data: (.*)$/m.exec(block)![1]!) });
    }
  }
  await reader.cancel().catch(() => {});
  return out;
}

const stream = (runId: string, headers: Record<string, string> = {}, query = "") =>
  streamRoute(new Request(`http://localhost/api/agent/runs/${runId}/events${query}`, { headers }), { params: Promise.resolve({ id: runId }) });

async function newRun() {
  return createRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", model: null, task: "t", trigger: "manual", simTime: new Date() });
}

describe("run event stream (SSE)", () => {
  it("replays a finished run in order, then ends", async () => {
    await resetDemo(database, "budget-exhausted");
    const { runId, done } = await startAgentRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", buyer: { fetchImpl: providerFetch().fetchImpl } });
    await done;
    const res = await stream(runId);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const msgs = await readSse(res);
    const events = msgs.filter((m) => m.event === "run-event");
    const persisted = await listRunEvents(database, runId);
    expect(events.map((m) => m.id)).toEqual(persisted.map((e) => e.seq));
    expect(events.map((m) => m.data.type)).toEqual(persisted.map((e) => e.type));
    expect(msgs.at(-1)).toMatchObject({ event: "end", data: { status: "completed" } });
  });

  it("resumes after Last-Event-ID (or ?after=) without repeating events", async () => {
    const runId = await newRun();
    for (let i = 0; i < 5; i++) await appendRunEvent(database, runId, { stage: "observing", type: `test.${i}` });
    await finishRun(database, runId, { status: "completed" });
    expect((await readSse(await stream(runId, { "last-event-id": "3" }))).filter((m) => m.event === "run-event").map((m) => m.id)).toEqual([4, 5]);
    expect((await readSse(await stream(runId, {}, "?after=4"))).filter((m) => m.event === "run-event").map((m) => m.id)).toEqual([5]);
  });

  it("forwards live events as they are persisted and ends with the run", async () => {
    const runId = await newRun();
    await appendRunEvent(database, runId, { stage: "planning", type: "run.started" });
    const reading = readSse(await stream(runId));
    await new Promise((r) => setTimeout(r, 50));
    await appendRunEvent(database, runId, { stage: "observing", type: "tool.called", tool: "observe_household" });
    await appendRunEvent(database, runId, { stage: "observing", type: "tool.result", tool: "observe_household" });
    await new Promise((r) => setTimeout(r, 20));
    await appendRunEvent(database, runId, { stage: "finished", type: "run.completed" });
    await finishRun(database, runId, { status: "completed" });
    const msgs = await reading;
    expect(msgs.filter((m) => m.event === "run-event").map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(msgs.at(-1)).toMatchObject({ event: "end", data: { status: "completed" } });
  });

  it("rejects malformed and unknown run ids", async () => {
    expect((await streamRoute(new Request("http://localhost/x"), { params: Promise.resolve({ id: "../etc" }) })).status).toBe(400);
    expect((await stream("run_000000000000nope")).status).toBe(404);
  });
});

describe("approval expiry", () => {
  async function parked(ttlSeconds = 180, withRun = false) {
    await resetDemo(database, "needs-approval");
    const runId = withRun ? await newRun() : undefined;
    await database.update(s.agentPolicies).set({ approvalTtlSeconds: ttlSeconds });
    return { ...(await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 5000, initiatedBy: "agent", runId })), runId: runId! };
  }

  it("parks with a deadline from the owner's approval window", async () => {
    const before = Date.now();
    const p = await parked(60);
    expect(p.stage).toBe("awaiting_approval");
    expect(p.approvalExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(p.approvalExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("an expired request cannot be approved; it is cancelled unpaid and the run is told", async () => {
    const p = await parked(180, true);
    const runId = p.runId;
    await database.update(s.purchases).set({ approvalExpiresAt: new Date(Date.now() - 1) }).where(eq(s.purchases.id, p.id));
    await expect(approvePurchase(database, p.id)).rejects.toBeInstanceOf(ApprovalExpiredError);
    const [row] = await database.select().from(s.purchases).where(eq(s.purchases.id, p.id));
    expect(row).toMatchObject({ stage: "cancelled", failureCode: "approval_expired", paymentStatus: "not_started" });
    expect(await database.select().from(s.payments)).toHaveLength(0);
    expect((await listRunEvents(database, runId)).map((e) => e.type)).toContain("approval.expired");
  });

  it("the approve endpoint answers 410 for an expired request", async () => {
    const p = await parked();
    await database.update(s.purchases).set({ approvalExpiresAt: new Date(Date.now() - 1) }).where(eq(s.purchases.id, p.id));
    const res = await purchaseAction(new Request(`http://localhost/api/purchases/${p.id}/approve`, { method: "POST" }), { params: Promise.resolve({ id: p.id, action: "approve" }) });
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("approval_expired");
  });

  it("the sweep closes stale requests so they stop blocking new decisions", async () => {
    const p = await parked();
    expect(await expireApprovals(database, DEMO_HOUSEHOLD_ID)).toEqual([]); // still in time
    await sweepInterruptedPurchases(database, DEMO_HOUSEHOLD_ID, Date.now() + 181_000);
    const [row] = await database.select().from(s.purchases).where(eq(s.purchases.id, p.id));
    expect(row!.stage).toBe("cancelled");
    // A new purchase for the same utility is no longer blocked by the stale request.
    const again = await createPurchase(database, { householdId: DEMO_HOUSEHOLD_ID, kind: "electricity", amountNgn: 5000, initiatedBy: "agent" });
    expect(again.stage).toBe("awaiting_approval");
  });

  it("declining in time is recorded in the run's log", async () => {
    const p = await parked(180, true);
    const runId = p.runId;
    await declinePurchase(database, p.id);
    expect((await listRunEvents(database, runId)).find((e) => e.type === "approval.declined")).toMatchObject({ purchaseId: p.id, decision: "declined" });
  });

  it("approval still cannot override hard limits", async () => {
    const p = await parked();
    await database.update(s.agentPolicies).set({ perPurchaseLimitNgn: 1000 });
    await expect(approvePurchase(database, p.id)).rejects.toBeInstanceOf(PolicyDeniedError);
  });
});

describe("run read model", () => {
  it("returns the run, its ordered events and its purchases with approval deadlines", async () => {
    await resetDemo(database, "needs-approval");
    const { runId, done } = await startAgentRun(database, { householdId: DEMO_HOUSEHOLD_ID, mode: "deterministic", buyer: { fetchImpl: providerFetch().fetchImpl } });
    await done;
    const view = (await getRunView(DEMO_HOUSEHOLD_ID, runId))!;
    expect(view.run).toMatchObject({ id: runId, status: "completed", mode: "deterministic", purchaseCount: 1 });
    expect(view.events.map((e) => e.seq)).toEqual(view.events.map((_, i) => i + 1));
    expect(view.purchases).toEqual([expect.objectContaining({ stage: "awaiting_approval", providerName: "Demo PowerGrid Vend", approvalExpiresAt: expect.any(String) })]);
    expect(view.events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(await getRunView(DEMO_HOUSEHOLD_ID, "run_000000000000nope")).toBeNull();
  });
});
