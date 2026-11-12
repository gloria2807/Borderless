/** Formatting shared by server and client. Pure, no Node APIs. */

export const naira = (n: number) => `₦${Math.round(n).toLocaleString("en-NG")}`;

export function quantity(value: number, unit: string, opts: { precise?: boolean } = {}): string {
  if (unit === "NGN") return naira(value);
  if (unit === "MB" && value >= 1024 && !opts.precise) {
    const gb = value / 1024;
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  }
  const v = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${v.toLocaleString("en-NG")} ${unit}`;
}

export function duration(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "No end in sight";
  if (hours < 1) return "Under 1 hour";
  if (hours < 36) return `${Math.round(hours)} h`;
  const d = hours / 24;
  return `${d < 10 ? d.toFixed(1).replace(/\.0$/, "") : Math.round(d)} days`;
}

export function durationLong(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "no depletion expected";
  if (hours < 1) return "less than an hour";
  if (hours < 36) {
    const h = Math.round(hours);
    return `about ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(hours / 24);
  return `about ${d} day${d === 1 ? "" : "s"}`;
}

const tz = "Africa/Lagos";
const fmtDayTime = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
const fmtTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
const fmtDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz });
const fmtFull = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: tz });

const asDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));
export const dayTime = (d: Date | string | number) => fmtDayTime.format(asDate(d));
export const clock = (d: Date | string | number) => fmtTime.format(asDate(d));
export const date = (d: Date | string | number) => fmtDate.format(asDate(d));
/** Calendar dates stored as UTC midnights (budget periods). */
const fmtCalendar = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const calendarDate = (d: Date | string | number) => fmtCalendar.format(asDate(d));
export const fullTimestamp = (d: Date | string | number) => `${fmtFull.format(asDate(d))} WAT`;

/** +2348030000417 → +234 803 ••• 0417 */
export function maskMsisdn(msisdn: string): string {
  const m = /^\+234(\d{3})\d{3}(\d{4})$/.exec(msisdn);
  return m ? `+234 ${m[1]} ••• ${m[2]}` : msisdn.replace(/\d(?=\d{4})/g, "•");
}

/** 45012345678 → 4501 2345 678 */
export const meterId = (id: string) => id.replace(/(\d{4})(\d{4})(\d+)/, "$1 $2 $3");

export const shortHash = (h: string, n = 8) => (h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-n)}` : h);
export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function atomicToDecimal(atomic: string | bigint, decimals = 7): string {
  const v = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac.padEnd(2, "0")}` : `${whole}.00`;
}

export const NETWORK_NAMES: Record<string, string> = { mtn: "MTN", airtel: "Airtel", glo: "Glo", t2: "9mobile (T2)" };
export const UTILITY_NAMES = { electricity: "Electricity", airtime: "Airtime", data: "Mobile data" } as const;
