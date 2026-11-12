"use client";

import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/primitives";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const config = /AGENT_STELLAR_SECRET|PAYTO|configuration/i.test(error.message);
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-coral/30 bg-coral-soft p-6">
      <CircleAlert className="size-5 text-coral" aria-hidden />
      <h1 className="mt-3 text-base font-semibold">This page couldn't load</h1>
      <p className="mt-1 text-[13px] text-fg-2">
        {config
          ? "The testnet wallets aren't configured. Run `pnpm wallets:setup`, then restart the app."
          : "Borderless couldn't read the household data. Nothing was paid or changed by this error."}
      </p>
      {error.digest && <p className="mono mt-2 text-2xs text-fg-3">Reference {error.digest}</p>}
      <Button className="mt-4" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
