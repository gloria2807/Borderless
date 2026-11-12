import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <p className="mono text-2xs text-fg-3">404</p>
        <h1 className="mt-2 text-lg font-semibold">There's nothing at this address</h1>
        <p className="mt-1 text-[13px] text-fg-2">The transaction or page may have been cleared by a demo reset.</p>
        <Link href="/" className="mt-4 inline-flex h-9 items-center rounded-md bg-green px-4 text-sm font-semibold text-[#10200f]">
          Go to overview
        </Link>
      </div>
    </main>
  );
}
