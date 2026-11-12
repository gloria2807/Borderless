/**
 * Server-only configuration. Never import from client components.
 *
 * Secrets are read lazily so that the UI can still run (read-only) when the
 * payment wallet is not configured; any payment attempt then fails loudly.
 */
import { z } from "zod";

const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;
const STELLAR_SECRET_KEY = /^S[A-Z2-7]{55}$/;

const baseSchema = z.object({
  DATABASE_URL: z.string().default("file:./data/borderless.db"),
  /**
   * Where the agent reaches the provider endpoints. Defaults to this server's own port
   * (Next.js sets PORT), so the agent never talks to some other local app on :3000.
   */
  APP_BASE_URL: z
    .string()
    .url()
    .default(() => `http://localhost:${process.env.PORT ?? "3000"}`),
  // Borderless is testnet-only by design. Mainnet is rejected, not merely discouraged.
  STELLAR_NETWORK: z.literal("stellar:testnet").default("stellar:testnet"),
  STELLAR_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  STELLAR_HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  STELLAR_EXPLORER_TX_URL: z.string().url().default("https://stellar.expert/explorer/testnet/tx"),
  X402_FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
  X402_FACILITATOR_API_KEY: z.string().min(1).optional(),
  /** Demo pricing: how many NGN of simulated value one testnet USDC pays for. NOT an exchange rate. */
  DEMO_NGN_PER_TESTNET_USDC: z.coerce.number().int().positive().default(100_000),
  PROVIDER_ELECTRICITY_PAYTO: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
  PROVIDER_AIRTIME_PAYTO: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
  PROVIDER_DATA_PAYTO: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
  AGENT_STELLAR_PUBLIC: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
});

export type ServerEnv = z.infer<typeof baseSchema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (!cached) {
    const parsed = baseSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid server configuration: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test hook. */
export function resetEnvCache(): void {
  cached = undefined;
}

export class ConfigurationError extends Error {
  readonly code = "configuration_error";
}

/** The agent's signing secret. Only the payments module may call this. */
export function agentSecret(): string {
  const secret = process.env.AGENT_STELLAR_SECRET;
  if (!secret || !STELLAR_SECRET_KEY.test(secret)) {
    throw new ConfigurationError(
      "AGENT_STELLAR_SECRET is missing or malformed. Run `pnpm wallets:setup` to create a testnet wallet.",
    );
  }
  return secret;
}

export function providerPayTo(kind: "electricity" | "airtime" | "data"): string {
  const e = env();
  const value =
    kind === "electricity"
      ? e.PROVIDER_ELECTRICITY_PAYTO
      : kind === "airtime"
        ? e.PROVIDER_AIRTIME_PAYTO
        : e.PROVIDER_DATA_PAYTO;
  if (!value) {
    throw new ConfigurationError(
      `PROVIDER_${kind.toUpperCase()}_PAYTO is not configured. Run \`pnpm wallets:setup\`.`,
    );
  }
  return value;
}
