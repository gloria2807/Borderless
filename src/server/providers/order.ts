import { z } from "zod";
import { MOBILE_NETWORKS } from "../db/schema";

const purchaseId = z.string().regex(/^pur_[0-9a-z]{10,40}$/, "invalid purchase id");
const quoteId = z.string().regex(/^qt_[0-9a-z]{10,40}$/, "invalid quote id");

/** What a buyer sends to request a quote (free, no payment). */
export const quoteRequestSchema = z
  .object({
    accountIdentifier: z.string().min(5).max(32),
    network: z.enum(MOBILE_NETWORKS).optional(),
    amountNgn: z.number().int().positive().optional(),
    productCode: z.string().min(1).max(64).optional(),
  })
  .strict();

/** What a buyer sends to a provider purchase endpoint. Every purchase redeems a quote. */
export const providerOrderSchema = quoteRequestSchema.extend({ purchaseId, quoteId }).strict();

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type ProviderOrder = z.infer<typeof providerOrderSchema>;

export const fulfilmentRetrySchema = z.object({ purchaseId }).strict();
