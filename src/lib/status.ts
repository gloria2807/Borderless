/**
 * Human labels and semantic tones for every persisted status. Payment and fulfilment
 * are always described separately — never merged into a single "success".
 */
export type Tone = "positive" | "warning" | "critical" | "info" | "neutral" | "progress";

export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  not_started: { label: "Not started", tone: "neutral", hint: "No payment has been attempted." },
  requires_payment: { label: "Payment requested", tone: "progress", hint: "The provider returned HTTP 402 with payment requirements." },
  submitted: { label: "Authorised, settling", tone: "progress", hint: "Signed authorisation sent; waiting for the facilitator to settle on Stellar testnet." },
  settled: { label: "Settled, confirming", tone: "progress", hint: "The facilitator reported settlement; Borderless is confirming the transfer on-chain." },
  confirmed: { label: "Payment confirmed", tone: "positive", hint: "The payment was successfully settled on Stellar testnet and verified on Horizon." },
  failed: { label: "Not charged", tone: "critical", hint: "The payment did not happen. No testnet funds left the agent wallet." },
  unknown: { label: "Outcome unknown", tone: "warning", hint: "The payment outcome could not be determined yet. It will be reconciled before any retry." },
};

export const FULFILMENT_STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  not_started: { label: "Not released", tone: "neutral", hint: "The provider has not released anything for this purchase." },
  pending: { label: "Release pending", tone: "progress", hint: "Waiting for the provider to release the simulated utility." },
  fulfilled: { label: "Utility released", tone: "positive", hint: "The demo provider released the simulated utility to the virtual device." },
  failed: { label: "Release failed", tone: "critical", hint: "The provider did not release the utility. It can be retried without paying again." },
};

export const STAGE: Record<string, { label: string; tone: Tone }> = {
  awaiting_approval: { label: "Awaiting your approval", tone: "warning" },
  requested: { label: "Requesting", tone: "progress" },
  payment_required: { label: "Payment required", tone: "progress" },
  submitted: { label: "Paying", tone: "progress" },
  completed: { label: "Completed", tone: "positive" },
  needs_attention: { label: "Needs attention", tone: "warning" },
  failed: { label: "Failed, not charged", tone: "critical" },
  cancelled: { label: "Declined", tone: "neutral" },
};

export const URGENCY: Record<string, { label: string; tone: Tone }> = {
  critical: { label: "Critical", tone: "critical" },
  low: { label: "Running low", tone: "warning" },
  watch: { label: "Watching", tone: "info" },
  ok: { label: "Healthy", tone: "positive" },
};

export const TONE_TEXT: Record<Tone, string> = {
  positive: "text-green",
  warning: "text-amber",
  critical: "text-coral",
  info: "text-cyan",
  neutral: "text-fg-2",
  progress: "text-fg-2",
};

export const TONE_BG: Record<Tone, string> = {
  positive: "bg-green",
  warning: "bg-amber",
  critical: "bg-coral",
  info: "bg-cyan",
  neutral: "bg-fg-3",
  progress: "bg-fg-2",
};
