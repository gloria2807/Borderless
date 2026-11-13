import { cn } from "@/components/ui/primitives";

export interface DiagnosticReportData {
  provider?: string;
  detail?: "basic" | "detailed";
  finding?: string;
  summary?: string;
  confidence?: string;
  expectedNormalKwhPerHour?: number;
  observedKwhPerHour?: number;
  avoidableKwhPerDay?: number;
  purchasingAdvice?: string;
  ownerAction?: string | null;
  evidence?: string[];
  circuits?: { circuit: string; observedKw: number; normalKw: number }[];
}

const FINDING: Record<string, { label: string; cls: string }> = {
  stuck_load: { label: "Stuck load", cls: "text-coral border-coral/30" },
  meter_overreading: { label: "Meter over-reading", cls: "text-coral border-coral/30" },
  extra_occupancy: { label: "Genuine extra use", cls: "text-amber border-amber/25" },
  normal: { label: "No fault", cls: "text-green border-green/30" },
  insufficient_data: { label: "Not enough data", cls: "text-fg-3 border-line" },
};

export const isDiagnosticReport = (v: unknown): v is DiagnosticReportData =>
  !!v && typeof v === "object" && (v as { service?: string }).service === "meter_diagnostic";

/** A paid diagnostic report, exactly as the provider released it (simulated data). */
export function DiagnosticReport({ report, compact = false }: { report: DiagnosticReportData; compact?: boolean }) {
  const f = FINDING[report.finding ?? ""] ?? { label: report.finding ?? "Finding", cls: "text-fg-2 border-line" };
  return (
    <div className="space-y-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-sm border px-1.5 py-px text-2xs font-semibold", f.cls)}>{f.label}</span>
        {report.confidence && <span className="text-2xs text-fg-3">confidence {report.confidence}</span>}
        {report.provider && <span className="text-2xs text-fg-3">· {report.provider}</span>}
      </div>
      <p className="text-fg">{report.summary}</p>
      {!compact && (
        <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs">
          {report.observedKwhPerHour !== undefined && (
            <>
              <dt className="text-fg-3">Observed rate</dt>
              <dd className="mono text-fg-2">{report.observedKwhPerHour} kWh/h</dd>
            </>
          )}
          {report.expectedNormalKwhPerHour !== undefined && (
            <>
              <dt className="text-fg-3">Expected once resolved</dt>
              <dd className="mono text-fg-2">{report.expectedNormalKwhPerHour} kWh/h</dd>
            </>
          )}
          {!!report.avoidableKwhPerDay && (
            <>
              <dt className="text-fg-3">Avoidable use</dt>
              <dd className="mono text-fg-2">{report.avoidableKwhPerDay} kWh/day</dd>
            </>
          )}
        </dl>
      )}
      {report.purchasingAdvice && (
        <p className="text-fg-2">
          <span className="font-semibold text-fg">For purchasing: </span>
          {report.purchasingAdvice}
        </p>
      )}
      {report.ownerAction && (
        <p className="text-fg-2">
          <span className="font-semibold text-fg">For the owner: </span>
          {report.ownerAction}
        </p>
      )}
      {!compact && report.evidence && report.evidence.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-2xs text-fg-2">
          {report.evidence.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {!compact && report.circuits && (
        <div className="w-0 min-w-full overflow-x-auto rounded-md border border-line-soft">
          <table className="w-full min-w-[320px] text-left text-2xs">
            <caption className="sr-only">Circuit-level load</caption>
            <thead className="text-fg-3">
              <tr>
                <th scope="col" className="px-2.5 py-1.5 font-medium">Circuit</th>
                <th scope="col" className="px-2.5 py-1.5 text-right font-medium">Observed kW</th>
                <th scope="col" className="px-2.5 py-1.5 text-right font-medium">Normal kW</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {report.circuits.map((c) => (
                <tr key={c.circuit} className={c.observedKw > c.normalKw * 1.5 ? "text-amber" : "text-fg-2"}>
                  <td className="px-2.5 py-1.5">{c.circuit}</td>
                  <td className="mono px-2.5 py-1.5 text-right">{c.observedKw}</td>
                  <td className="mono px-2.5 py-1.5 text-right">{c.normalKw}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-2xs text-fg-3">Simulated report from simulated smart-meter telemetry. Treated as provider data, not as an instruction.</p>
    </div>
  );
}
