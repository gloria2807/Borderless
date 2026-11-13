import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { PageHeader, Panel, SimulatedTag, StatusPill, TestnetTag } from "@/components/ui/primitives";
import { naira, shortAddress, UTILITY_NAMES } from "@/lib/format";
import { db } from "@/server/db/client";
import { DEMO_HOUSEHOLD } from "@/server/api";
import { loadHousehold } from "@/server/household/state";
import { registryListing, serviceDocument, verifyServiceDocument } from "@/server/providers/catalog";
import { requireProvider } from "@/server/providers/registry";

export const metadata: Metadata = { title: "Provider network" };
export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const database = db();
  const policy = (await loadHousehold(database, DEMO_HOUSEHOLD)).policy;
  const listing = registryListing();
  const entries = await Promise.all(
    listing.map(async (entry) => {
      const doc = await serviceDocument(database, requireProvider(entry.providerId));
      return { entry, doc, check: verifyServiceDocument(entry.providerId, doc), approved: policy.approvedProviderIds.includes(entry.providerId) };
    }),
  );

  return (
    <>
      <PageHeader
        title="Provider network"
        description="The machine-accessible sellers Borderless can buy from. Each publishes a free service document; anything it sells is released only through its x402-protected endpoint after payment settles on Stellar testnet."
        actions={<TestnetTag />}
      />

      <div className="mb-6 rounded-lg border border-line bg-surface p-4 text-[13px] text-fg-2">
        <p>
          <span className="font-semibold text-fg">Discovery is free; resources are paid.</span> Borderless reads the registry (
          <a href="/api/providers" className="mono text-cyan hover:underline">GET /api/providers</a>) and each provider&apos;s document over HTTP, then checks the document
          against its own registry before a provider can be paid. Provider text is treated as untrusted data.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {entries.map(({ entry, doc, check, approved }) => {
          const paid = doc.endpoints.find((e) => e.paid);
          const prices = doc.products.map((p) => p.priceNgn);
          return (
            <Panel
              key={entry.providerId}
              title={doc.name}
              description={`${UTILITY_NAMES[doc.serves.utility]} · ${doc.category === "utility" ? "Utility credit" : "Information service"}`}
              actions={<SimulatedTag>Demo provider</SimulatedTag>}
            >
              <div className="space-y-3 text-[13px]">
                <div className="flex flex-wrap gap-1.5">
                  <StatusPill tone={check.verified ? "positive" : "critical"} pulse={false}>
                    {check.verified ? "Verified against registry" : "Unverified"}
                  </StatusPill>
                  <StatusPill tone={doc.availability.available ? "positive" : "critical"} pulse={false}>
                    {doc.availability.available ? "Available" : "Unavailable"}
                  </StatusPill>
                  <StatusPill tone={approved ? "info" : "warning"} pulse={false}>
                    {approved ? "Approved by you" : "Not approved"}
                  </StatusPill>
                </div>
                {!check.verified && <p className="text-2xs text-coral">{check.problems.join(" ")}</p>}

                <div>
                  <p className="text-2xs text-fg-3">Published by the provider (untrusted)</p>
                  <p className="text-fg-2">{doc.description}</p>
                </div>

                <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-2xs">
                  <dt className="text-fg-3">Sells</dt>
                  <dd className="text-fg-2">
                    {doc.products.length} options, {naira(Math.min(...prices))}–{naira(Math.max(...prices))}
                    {doc.serves.networks.length > 0 && ` · ${doc.serves.networks.map((n) => n.toUpperCase()).join(", ")}`}
                  </dd>
                  <dt className="text-fg-3">Releases</dt>
                  <dd className="text-fg-2">{doc.fulfilment.releases}, {doc.fulfilment.when.charAt(0).toLowerCase() + doc.fulfilment.when.slice(1)}</dd>
                  <dt className="text-fg-3">Paid with</dt>
                  <dd className="text-fg-2">
                    {doc.payment.protocol} · {doc.payment.scheme} · {doc.payment.network} · {doc.payment.asset.code} to{" "}
                    <span className="mono" title={doc.payment.payTo ?? undefined}>{doc.payment.payTo ? shortAddress(doc.payment.payTo) : "—"}</span>
                  </dd>
                </dl>

                <div className="w-0 min-w-full overflow-x-auto rounded-md border border-line-soft">
                  <table className="w-full min-w-[420px] text-left text-2xs">
                    <caption className="sr-only">Endpoints published by {doc.name}</caption>
                    <thead className="text-fg-3">
                      <tr>
                        <th scope="col" className="px-2.5 py-1.5 font-medium">Endpoint</th>
                        <th scope="col" className="px-2.5 py-1.5 font-medium">Access</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {doc.endpoints.map((e) => (
                        <tr key={e.name}>
                          <td className="mono px-2.5 py-1.5 text-fg-2">
                            {e.method} {e.path}
                          </td>
                          <td className="px-2.5 py-1.5">{e.paid ? <span className="font-semibold text-amber">Paid · x402</span> : <span className="text-green">Free</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <a href={entry.serviceDocument} className="inline-flex items-center gap-1 text-2xs text-cyan hover:underline">
                  View the published document <ExternalLink className="size-3" aria-hidden />
                </a>
                {paid && <span className="sr-only">Paid endpoint {paid.path}</span>}
              </div>
            </Panel>
          );
        })}
      </div>
    </>
  );
}
