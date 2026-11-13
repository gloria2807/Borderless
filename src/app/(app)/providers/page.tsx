import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { PageHeader, Panel, SectionLabel, SimulatedTag, StatusPill, TestnetTag } from "@/components/ui/primitives";
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
        eyebrow="Procurement"
        title="Provider network"
        description="The machine-accessible sellers Borderless can buy from. Each publishes a free service document; anything it sells is released only through its x402-protected endpoint after payment settles on Stellar testnet."
        actions={<TestnetTag />}
      />

      <section aria-labelledby="how-title" className="mb-8">
        <SectionLabel as="h2">
          <span id="how-title">How Borderless buys</span>
        </SectionLabel>
        <div className="grid gap-px overflow-hidden rounded-lg bg-fg/[0.07] shadow-ring md:grid-cols-2">
          <div className="bg-surface p-5">
            <p className="label">A typical top-up app</p>
            <ul className="mt-3 space-y-2 text-[13px] text-fg-2">
              {["Buys from a provider chosen in advance.", "Usually tops up when a fixed threshold is crossed.", "Is integrated through accounts, credentials or a checkout set up beforehand.", "Buys the same thing whatever caused the shortfall."].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-fg-4" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-ink p-5 text-white">
            <p className="label text-green-bright">Borderless</p>
            <ul className="mt-3 space-y-2 text-[13px] text-white/80">
              {[
                "Observes the household and identifies what it actually needs.",
                "Discovers machine-accessible providers and compares their offers.",
                "Buys information when it could change the decision — or decides to buy nothing.",
                "Pays each provider per request through x402, within your rules, then verifies what it got and reassesses.",
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-green-bright" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-3 max-w-4xl text-[11.5px] leading-relaxed text-fg-3">
          What this demo proves, and no more: these (simulated) provider services are designed for agent customers, and x402 on Stellar testnet is the payment and access mechanism they
          actually implement. Without paying, the agent cannot obtain them — open any purchase and use <span className="font-medium text-fg-2">Request without paying</span> to see the provider&apos;s HTTP 402.
        </p>
      </section>

      <div className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-bg-2 px-4 py-3 text-[12.5px] text-fg-2">
        <span className="flex items-center gap-2">
          <span className="rounded-full bg-green-soft px-2 py-px text-[11px] font-medium text-green">Free</span> Discovery, metadata and utility quotes
        </span>
        <span className="flex items-center gap-2">
          <span className="rounded-full bg-amber-soft px-2 py-px text-[11px] font-medium text-amber">Paid (x402)</span> Utility credit and information
        </span>
        <span className="text-fg-3">
          Borderless reads <a href="/api/providers" className="mono text-cyan hover:underline">GET /api/providers</a> and each document over HTTP, and checks it against its own registry before a provider can be paid. Provider text is untrusted data.
        </span>
      </div>

      {(["utility", "intelligence"] as const).map((cat) => (
      <section key={cat} className="mb-8" aria-label={cat === "utility" ? "Utility providers" : "Information services"}>
      <SectionLabel as="h2" aside={<span className="mono text-[10.5px] text-fg-3">{entries.filter((x) => x.doc.category === cat).length} providers</span>}>
        {cat === "utility" ? "Utility credit" : "Information services"}
      </SectionLabel>
      <div className="grid gap-4 lg:grid-cols-2">
        {entries.filter((x) => x.doc.category === cat).map(({ entry, doc, check, approved }) => {
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
                  <p className="label">Published by the provider · untrusted</p>
                  <p className="mt-1 text-fg-2">{doc.description}</p>
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

                <div className="w-0 min-w-full overflow-x-auto rounded-lg bg-bg shadow-[inset_0_0_0_1px_rgb(12_13_12/0.07)]">
                  <table className="w-full min-w-[420px] text-left text-2xs">
                    <caption className="sr-only">Endpoints published by {doc.name}</caption>
                    <thead className="mono text-[10px] tracking-[0.08em] text-fg-3 uppercase">
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
                          <td className="px-2.5 py-1.5">{e.paid ? <span className="rounded-full bg-amber-soft px-2 py-px font-medium text-amber">Paid · x402</span> : <span className="rounded-full bg-green-soft px-2 py-px font-medium text-green">Free</span>}</td>
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
      </section>
      ))}
    </>
  );
}
