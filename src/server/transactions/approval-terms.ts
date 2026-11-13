/**
 * Approval binding. When a purchase is parked for the owner, the exact terms they are
 * asked to approve are frozen and hashed: provider, product, NGN price, testnet USDC
 * amount, payee wallet, asset, network and the recipient account.
 *
 *  - The owner's approval must quote that hash, so a click can only approve what was
 *    shown (no swap between display and click).
 *  - At approval time the terms are re-derived from the registry and catalogue; if
 *    anything moved (price, payee), the approval is refused and the agent re-decides.
 *  - Immediately before signing, the HTTP 402 must ask for exactly these terms.
 */
import { createHash } from "node:crypto";
import { env } from "../config/env";
import type { UtilityKind } from "../db/schema";
import { ngnToTestnetUsdcAtomic, TESTNET_USDC } from "../payments/pricing";
import { providerPayTo, requireProvider } from "../providers/registry";

export interface ApprovalTerms {
  purchaseId: string;
  kind: UtilityKind;
  providerId: string;
  providerName: string;
  productCode: string;
  label: string;
  amountNgn: number;
  amountAtomic: string;
  asset: string;
  network: "stellar:testnet";
  payTo: string;
  recipient: string;
}

export function approvalTermsFor(p: {
  purchaseId: string;
  kind: UtilityKind;
  providerId: string;
  productCode: string;
  amountNgn: number;
  recipient: string;
  quote?: { amountAtomic: string; payTo: string } | null;
}): ApprovalTerms {
  const provider = requireProvider(p.providerId);
  const product = provider.resolveProduct(p.kind === "data" ? { productCode: p.productCode } : { amountNgn: p.amountNgn });
  return {
    purchaseId: p.purchaseId,
    kind: p.kind,
    providerId: p.providerId,
    providerName: provider.definition.name,
    productCode: product.code,
    label: product.label,
    amountNgn: product.amountNgn,
    amountAtomic: p.quote?.amountAtomic ?? ngnToTestnetUsdcAtomic(product.amountNgn, env().DEMO_NGN_PER_TESTNET_USDC).toString(),
    asset: TESTNET_USDC.contract,
    network: "stellar:testnet",
    payTo: p.quote?.payTo ?? providerPayTo(p.providerId),
    recipient: p.recipient,
  };
}

/** Stable SHA-256 over the terms (keys sorted), hex. */
export function hashTerms(t: ApprovalTerms): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(t).sort(([a], [b]) => a.localeCompare(b))));
  return createHash("sha256").update(canonical).digest("hex");
}

/** Which fields differ between what was approved and what applies now. */
export function changedFields(approved: ApprovalTerms, current: ApprovalTerms): (keyof ApprovalTerms)[] {
  return (Object.keys(approved) as (keyof ApprovalTerms)[]).filter((k) => approved[k] !== current[k]);
}
