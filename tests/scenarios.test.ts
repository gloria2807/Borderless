/**
 * Each demo scenario is only a starting state. These tests run the REAL engine on it
 * and check the story the scenario promises actually emerges from the decision logic.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { decide } from "@/server/agent/engine";
import { explain } from "@/server/agent/explain";
import { buildDecisionInput } from "@/server/agent/run";
import type { Database } from "@/server/db/client";
import { SCENARIOS } from "@/server/demo/scenarios";
import { DEMO_HOUSEHOLD_ID, resetDemo } from "@/server/household/seed";
import { configureTestEnv, freshDatabase } from "./helpers";

let database: Database;
beforeEach(async () => {
  configureTestEnv();
  database = await freshDatabase();
});

async function decisionFor(id: string) {
  await resetDemo(database, id);
  const d = decide(await buildDecisionInput(database, DEMO_HOUSEHOLD_ID));
  return { d, e: explain(d) };
}
const kinds = (xs: { kind: string }[]) => xs.map((x) => x.kind);

describe("demo scenarios", () => {
  it("has unique ids and complete copy", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) expect(s.name && s.summary && s.expect).toBeTruthy();
  });

  it("both-low: buys data first, then electricity, within budget", async () => {
    const { d } = await decisionFor("both-low");
    expect(kinds(d.selected)).toEqual(["data", "electricity"]);
    expect(d.budgetImpact.remainingAfterNgn).toBeGreaterThanOrEqual(0);
  });

  it("budget-covers-one: buys electricity, defers data because of the budget", async () => {
    const { d, e } = await decisionFor("budget-covers-one");
    expect(kinds(d.selected)).toEqual(["electricity"]);
    expect(d.deferred.find((x) => x.kind === "data")).toMatchObject({ reason: "insufficient_budget", outrankedBy: "electricity" });
    expect(e.reasoning).toMatch(/deferred mobile data/);
  });

  it("unusual-data: flags data, buys nothing for it", async () => {
    const { d } = await decisionFor("unusual-data");
    expect(d.outcome).toBe("flagged");
    expect(d.flags.map((f) => f.kind)).toEqual(["data"]);
    expect(kinds(d.selected)).not.toContain("data");
  });

  it("budget-exhausted: blocked, no purchase, asks the owner to act", async () => {
    const { d, e } = await decisionFor("budget-exhausted");
    expect(d.outcome).toBe("blocked");
    expect(d.selected).toEqual([]);
    expect(e.reasoning).toMatch(/Increase the budget/);
  });

  it("needs-approval: parks the electricity purchase for the owner", async () => {
    const { d } = await decisionFor("needs-approval");
    expect(d.outcome).toBe("awaiting_approval");
    expect(d.selected[0]).toMatchObject({ kind: "electricity", requiresApproval: true });
  });

  it("authority-revoked: recommends but spends nothing", async () => {
    const { d } = await decisionFor("authority-revoked");
    expect(d.selected).toEqual([]);
    expect(d.deferred[0]).toMatchObject({ reason: "agent_disabled" });
    expect(d.deferred[0]?.recommendation).not.toBeNull();
  });
});
