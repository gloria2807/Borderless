import type { Metadata } from "next";
import { FundingGuardPanel } from "@/components/settings/funding-guard-panel";
import { AgentControls } from "@/components/settings/agent-controls";
import { SettingsForm } from "@/components/settings/settings-form";
import { ALL_PROVIDERS, eligibilityFor } from "@/server/providers/registry";
import { agentControlState } from "@/server/agent/control";
import { accountEligibilityInputs } from "@/server/views/authority";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { env } from "@/server/config/env";
import { db } from "@/server/db/client";
import { fundingGuardStatus } from "@/server/payments/funding-guard";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { getHouseholdOverview } from "@/server/views/household";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [o, guard, control, accounts] = await Promise.all([getHouseholdOverview(DEMO_HOUSEHOLD), fundingGuardStatus(db(), DEMO_HOUSEHOLD), agentControlState(db(), DEMO_HOUSEHOLD), accountEligibilityInputs(db(), DEMO_HOUSEHOLD)]);
  const s = o.budget.summary;
  const providers = ALL_PROVIDERS.map((m) => {
    const d = m.definition;
    const acct = accounts[d.kind];
    const e = d.category === "intelligence" ? { eligible: true, reason: "information about your meter" } : acct ? eligibilityFor(m, acct) : { eligible: false, reason: "no account" };
    return { id: d.id, name: d.name, kind: d.kind, category: d.category, eligible: e.eligible, eligibility: e.reason.replace(/\.$/, "") };
  });
  return (
    <div className="max-w-4xl">
      <PageHeader
        eyebrow={o.household.owner ? `${o.household.name} · ${o.household.owner}, owner` : "Spending authority"}
        title="Settings"
        description={`${o.household.owner ?? "The owner"} decides what Borderless may buy, how much it may spend and when it must ask. Changes apply from its next decision.`}
      />
      <div className="mb-6">
        <AgentControls paused={control.paused} autoPurchaseEnabled={control.autoPurchaseEnabled} />
      </div>
      <SettingsForm
        rate={env().DEMO_NGN_PER_TESTNET_USDC}
        providers={providers}
        key={JSON.stringify(o.policy) + o.budget.amountNgn + o.household.name}
        spentNgn={s.priorSpendNgn + s.spentNgn + s.committedNgn}
        initial={{
          householdName: o.household.name,
          budgetAmountNgn: o.budget.amountNgn,
          budgetPeriod: o.budget.period ?? "monthly",
          autoPurchaseEnabled: o.policy.autoPurchaseEnabled,
          perPurchaseLimitNgn: o.policy.perPurchaseLimitNgn,
          overallAgentLimitNgn: o.policy.overallAgentLimitNgn,
          manualApprovalThresholdNgn: o.policy.manualApprovalThresholdNgn,
          priorities: o.priorities,
          approvedServices: o.policy.approvedServices,
          approvedNetworks: o.policy.approvedNetworks,
          dailyAgentBudgetNgn: o.policy.dailyAgentBudgetNgn ?? 0,
          taskBudgetNgn: o.policy.taskBudgetNgn ?? 0,
          reserveNgn: o.policy.reserveNgn ?? 0,
          intelligenceCapNgn: o.policy.intelligenceCapNgn ?? 1000,
          approvalTtlSeconds: o.policy.approvalTtlSeconds ?? 180,
          approvedProviderIds: o.policy.approvedProviderIds,
          maxPerUtilityNgn: { electricity: o.policy.maxPerUtilityNgn?.electricity ?? 0, airtime: o.policy.maxPerUtilityNgn?.airtime ?? 0, data: o.policy.maxPerUtilityNgn?.data ?? 0 },
        }}
      />
      <div className="mt-8">
        <Panel title="Funding guard" description="A network-enforced ceiling on what the agent wallet can draw from the household treasury">
          <FundingGuardPanel status={guard} explorer={env().STELLAR_EXPLORER_TX_URL.replace(/\/+$/, "")} />
        </Panel>
      </div>
    </div>
  );
}
