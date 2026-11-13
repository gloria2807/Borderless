/**
 * Read-only status of the Stellar TESTNET demo wallets: funded? trustline? balances?
 * Prints public keys only.   pnpm wallets:status
 */
import "./_env";
import { Horizon } from "@stellar/stellar-sdk";

const horizon = new Horizon.Server(process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org");
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const wallets: [string, string | undefined][] = [
  ["Agent payer", process.env.AGENT_STELLAR_PUBLIC],
  ["Household treasury", process.env.TREASURY_STELLAR_PUBLIC],
  ["Empty demo wallet", process.env.DEMO_EMPTY_WALLET_PUBLIC],
  ["Electricity provider", process.env.PROVIDER_ELECTRICITY_PAYTO],
  ["Airtime provider", process.env.PROVIDER_AIRTIME_PAYTO],
  ["Data provider", process.env.PROVIDER_DATA_PAYTO],
  ["PowerGrid provider", process.env.PROVIDER_POWERGRID_PAYTO],
  ["TopUp Hub provider", process.env.PROVIDER_TOPUPHUB_PAYTO],
  ["DataLink provider", process.env.PROVIDER_DATALINK_PAYTO],
  ["GridSense diagnostics", process.env.PROVIDER_GRIDSENSE_PAYTO],
  ["MeterLab diagnostics", process.env.PROVIDER_METERLAB_PAYTO],
];

let problems = 0;
console.log("\nBorderless testnet wallets (testnet assets have no real-world value)\n");
for (const [label, pub] of wallets) {
  if (!pub) {
    console.log(`✗ ${label.padEnd(22)} not configured. Run \`pnpm wallets:setup\`.`);
    problems += 1;
    continue;
  }
  try {
    const acc = await horizon.loadAccount(pub);
    const xlm = acc.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
    const usdc = acc.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && "asset_issuer" in b && b.asset_issuer === ISSUER);
    const ok = !!usdc;
    if (!ok) problems += 1;
    console.log(`${ok ? "✓" : "✗"} ${label.padEnd(22)} ${pub}  XLM ${Number(xlm).toFixed(2).padStart(10)}  USDC ${usdc ? Number(usdc.balance).toFixed(4).padStart(9) : "no trustline"}`);
  } catch (err) {
    problems += 1;
    const notFound = (err as { response?: { status?: number } }).response?.status === 404;
    console.log(`✗ ${label.padEnd(22)} ${pub}  ${notFound ? "not found on testnet (testnet may have been reset). Run `pnpm wallets:setup`." : (err as Error).message}`);
  }
}
console.log(problems ? `\n${problems} wallet(s) need attention.\n` : "\nAll wallets ready.\n");
process.exit(problems ? 1 : 0);
