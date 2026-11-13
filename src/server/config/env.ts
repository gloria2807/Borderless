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
  PROVIDER_POWERGRID_PAYTO: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
  PROVIDER_TOPUPHUB_PAYTO: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
  PROVIDER_DATALINK_PAYTO: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
  AGENT_STELLAR_PUBLIC: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
  // Funding guard: a household treasury grants the agent wallet a capped, expiring allowance.
  TREASURY_STELLAR_PUBLIC: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
  /** A funded-for-fees but EMPTY testnet wallet, used by the "empty wallet" demo scenario. */
  DEMO_EMPTY_WALLET_PUBLIC: z.string().regex(STELLAR_PUBLIC_KEY).optional(),
  SOROBAN_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  /** When the agent wallet is short before a payment, top it up to this many testnet USDC. */
  FUNDING_GUARD_FLOAT_TARGET_USDC: z.coerce.number().positive().max(1000).default(1),
  // AI planner. Gemini (via its OpenAI-compatible endpoint) or OpenAI. Keys are read lazily by aiProvider().
  /** Which model provider plans: "gemini" or "openai". Default: Gemini if GEMINI_API_KEY is set, else OpenAI. */
  AI_PROVIDER: z.enum(["gemini", "openai"]).optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash"),
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/openai/"),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  AGENT_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  AGENT_MAX_STEPS: z.coerce.number().int().min(4).max(40).default(18),
  AGENT_RUN_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
  AGENT_MODEL_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(300).default(60),
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

/**
 * The household treasury secret (Funding guard). Demo only: in a real deployment the owner
 * holds this key and signs the allowance in their own wallet. Never sent to the browser.
 */
export function treasurySecret(): string | null {
  const secret = process.env.TREASURY_STELLAR_SECRET;
  return secret && STELLAR_SECRET_KEY.test(secret) ? secret : null;
}

/** Secret of the empty demo wallet (insufficient-funds scenario). Holds no USDC. */
export function emptyWalletSecret(): string | null {
  const secret = process.env.DEMO_EMPTY_WALLET_SECRET;
  return secret && STELLAR_SECRET_KEY.test(secret) ? secret : null;
}

/** OpenAI key for the AI planner. Server-only; never sent to the browser or logged. */
export function openaiApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key && key.length > 20 ? key : null;
}

/** Gemini key for the AI planner. Server-only; never sent to the browser or logged. */
export function geminiApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key && key.length > 20 ? key : null;
}

export interface AiProvider {
  provider: "gemini" | "openai";
  apiKey: string;
  model: string;
  /** OpenAI-compatible base URL (Gemini); undefined = OpenAI's own. */
  baseURL?: string;
}

/**
 * The model provider the AI planner uses. Both are called through the OpenAI SDK: Gemini
 * exposes an OpenAI-compatible Chat Completions endpoint with tool calling.
 */
export function aiProvider(): AiProvider | null {
  const cfg = env();
  const gemini = geminiApiKey();
  const openai = openaiApiKey();
  const choice = cfg.AI_PROVIDER ?? (gemini ? "gemini" : "openai");
  if (choice === "gemini") return gemini ? { provider: "gemini", apiKey: gemini, model: cfg.GEMINI_MODEL, baseURL: cfg.GEMINI_BASE_URL } : null;
  return openai ? { provider: "openai", apiKey: openai, model: cfg.OPENAI_MODEL } : null;
}

/**
 * A provider's registered receiving wallet, read from the named environment variable.
 * This registry — not anything a provider says in a quote or a 402 — is the trust anchor
 * for where the agent may send money.
 */
export function payToFromEnv(varName: string): string {
  const value = process.env[varName]?.trim();
  if (!value || !STELLAR_PUBLIC_KEY.test(value)) {
    throw new ConfigurationError(`${varName} is missing or invalid. Run \`pnpm wallets:setup\`.`);
  }
  return value;
}
