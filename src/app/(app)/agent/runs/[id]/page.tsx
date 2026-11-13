import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { RunConsole } from "@/components/agent/run-console";
import { PageHeader } from "@/components/ui/primitives";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { getRunView } from "@/server/views/runs";

export const metadata: Metadata = { title: "Agent run" };
export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^run_[0-9a-z]+$/.test(id)) notFound();
  const view = await getRunView(DEMO_HOUSEHOLD, id);
  if (!view) notFound();
  return (
    <>
      <Link href="/agent" className="mb-3 inline-flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
        <ArrowLeft className="size-3.5" aria-hidden /> Agent
      </Link>
      <PageHeader
        eyebrow={`Run ${id}`}
        title="Agent operations"
        description="Each step below is a backend event, recorded before it is shown. Expand any step to see the exact data the agent and the payment code worked with."
      />
      <RunConsole view={view} />
    </>
  );
}
