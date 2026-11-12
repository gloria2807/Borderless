import type { Unit } from "./catalog";

/** Structured receipt returned by every demo provider. Payment and fulfilment are reported separately. */
export interface ProviderReceipt {
  receiptId: string;
  simulated: true;
  disclaimer: string;
  provider: { id: string; name: string; kind: "electricity" | "airtime" | "data" };
  purchaseId: string;
  recipient: { identifier: string; network: string | null };
  product: { code: string; label: string; amountNgn: number; quantity: number; unit: Unit };
  payment: {
    status: "settled";
    network: string;
    asset: string;
    amountAtomic: string;
    txHash: string;
    payer: string | null;
    settledAt: string;
  };
  fulfilment:
    | {
        status: "fulfilled";
        balanceBefore: number;
        balanceAfter: number;
        quantity: number;
        unit: Unit;
        demoToken: string | null;
        details: Record<string, unknown>;
        fulfilledAt: string;
      }
    | { status: "pending" | "failed"; lastError: string | null };
}
