/**
 * Returns the testnet USDC that demo providers received back to the agent payer wallet, so the
 * live demo can be repeated without new faucet funding. TESTNET ONLY; testnet USDC has no value.
 *
 * Each provider wallet signs one ordinary USDC payment to the agent wallet with its own key
 * (kept in .env.local only for testnet maintenance; the running app never reads provider secrets).
 * The payments are real testnet transactions and show up on Stellar Expert like any other.
 *
 * Usage: pnpm wallets:recycle [--keep 0]
 */
import "./_env";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const HORIZON_URL = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
if (process.env.STELLAR_NETWORK && process.env.STELLAR_NETWORK !== "stellar:testnet") throw new Error("wallets:recycle runs on Stellar testnet only.");
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const horizon = new Horizon.Server(HORIZON_URL);

const PROVIDERS = ["ELECTRICITY", "AIRTIME", "DATA", "POWERGRID", "TOPUPHUB", "DATALINK", "GRIDSENSE", "METERLAB"];
const args = process.argv.slice(2);
const keepIdx = args.indexOf("--keep");
const KEEP = keepIdx >= 0 ? Number(args[keepIdx + 1]) : 0;

const usdcOf = (a: Horizon.AccountResponse) => {
  const line = a.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && "asset_issuer" in b && b.asset_issuer === USDC.issuer);
  return line ? Number(line.balance) : 0;
};

async function main() {
  const agent = process.env.AGENT_STELLAR_PUBLIC;
  if (!agent) throw new Error("AGENT_STELLAR_PUBLIC is not set. Run pnpm wallets:setup first.");
  let total = 0;
  for (const name of PROVIDERS) {
    const secret = process.env[`PROVIDER_${name}_SECRET`];
    if (!secret) {
      console.log(`- ${name.toLowerCase()}: no secret in .env.local, skipped`);
      continue;
    }
    const kp = Keypair.fromSecret(secret);
    const account = await horizon.loadAccount(kp.publicKey());
    const amount = Math.floor((usdcOf(account) - KEEP) * 1e7) / 1e7;
    if (amount <= 0) {
      console.log(`- ${name.toLowerCase()}: nothing to return`);
      continue;
    }
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: agent, asset: USDC, amount: amount.toFixed(7) }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    const res = await horizon.submitTransaction(tx);
    total += amount;
    console.log(`✓ ${name.toLowerCase()}: returned ${amount.toFixed(7)} USDC (tx ${res.hash})`);
  }
  const after = usdcOf(await horizon.loadAccount(agent));
  console.log(`\nReturned ${total.toFixed(4)} testnet USDC. Agent wallet now holds ${after.toFixed(4)} USDC.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
