import type { Metadata } from "next";
import { FundingGuardPanel } from "@/components/settings/funding-guard-panel";
import { SettingsForm } from "@/components/settings/settings-form";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { env } from "@/server/config/env";
import { db } from "@/server/db/client";
import { fundingGuardStatus } from "@/server/payments/funding-guard";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { getHouseholdOverview } from "@/server/views/household";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [o, guard] = await Promise.all([getHouseholdOverview(DEMO_HOUSEHOLD), fundingGuardStatus(db(), DEMO_HOUSEHOLD)]);
  const s = o.budget.summary;
  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" description="You decide what Borderless may buy, how much it may spend and when it must ask you. Changes apply from its next decision." />
      <SettingsForm
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
