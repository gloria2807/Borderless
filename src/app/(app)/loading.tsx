export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-6">
      <div className="h-8 w-72 animate-pulse rounded-md bg-surface" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="h-64 animate-pulse rounded-lg border border-line-soft bg-surface" />
        <div className="h-64 animate-pulse rounded-lg border border-line-soft bg-surface" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-44 animate-pulse rounded-lg border border-line-soft bg-surface" />
        ))}
      </div>
    </div>
  );
}
