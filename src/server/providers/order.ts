import { z } from "zod";
import { MOBILE_NETWORKS } from "../db/schema";

/** What a buyer sends to a provider purchase endpoint. */
export const providerOrderSchema = z
  .object({
    purchaseId: z.string().regex(/^pur_[0-9a-z]{10,40}$/, "invalid purchase id"),
    accountIdentifier: z.string().min(5).max(32),
    network: z.enum(MOBILE_NETWORKS).optional(),
    amountNgn: z.number().int().positive().optional(),
    productCode: z.string().min(1).max(64).optional(),
  })
  .strict();

export type ProviderOrder = z.infer<typeof providerOrderSchema>;

export const fulfilmentRetrySchema = z.object({ purchaseId: providerOrderSchema.shape.purchaseId }).strict();
