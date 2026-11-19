/**
 * Keep background work alive after the HTTP response is sent.
 *
 * On a long-lived Node server (pnpm start, pnpm dev) a promise keeps running on its own.
 * On serverless hosts such as Vercel the function is frozen once the response is sent,
 * so the work is handed to Next.js `after()`, which keeps the function running until it
 * settles (up to the route's maxDuration). Outside a request (scripts, tests) `after()`
 * is unavailable and not needed.
 */
import { after } from "next/server";

export function keepAlive(work: Promise<unknown>): void {
  try {
    after(() => work.then(
      () => undefined,
      () => undefined,
    ));
  } catch {
    /* Not inside a request: the process stays alive by itself. */
  }
}
