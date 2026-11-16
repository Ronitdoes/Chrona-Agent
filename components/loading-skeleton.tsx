export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`block rounded-md bg-border/60 motion-safe:animate-pulse ${className}`} />;
}

export function HistoryRowsSkeleton({ rows = 5 }: { rows?: number }) {
  const widths = ["w-4/5", "w-3/5", "w-11/12", "w-2/3", "w-3/4"];
  return <div aria-hidden="true" className="space-y-1">
    {Array.from({ length: rows }, (_, index) => <div key={index} className="flex h-10 items-center gap-2.5 px-2">
      <Skeleton className="size-1.5 shrink-0 rounded-full" />
      <Skeleton className={`h-3 ${widths[index % widths.length]}`} />
    </div>)}
  </div>;
}

export function ResponseSkeleton() {
  return <div aria-hidden="true" className="space-y-3 py-2">
    <Skeleton className="h-3.5 w-[92%]" />
    <Skeleton className="h-3.5 w-full" />
    <Skeleton className="h-3.5 w-3/5" />
  </div>;
}

export function ConversationSkeleton({ label = "Loading conversation" }: { label?: string }) {
  return <div role="status" aria-label={label} className="space-y-9 py-5">
    <span className="sr-only">{label}…</span>
    <div aria-hidden="true" className="ml-auto max-w-[75%] rounded-2xl rounded-br-md bg-surface-2/60 px-5 py-4">
      <Skeleton className="h-3 w-44 max-w-full" />
      <Skeleton className="mt-2.5 h-3 w-28 max-w-full" />
    </div>
    <div aria-hidden="true">
      <div className="mb-4 flex h-6 items-center gap-2">
        <Skeleton className="size-6 rounded-full" />
        <Skeleton className="h-3 w-14" />
      </div>
      <ResponseSkeleton />
      <div className="mt-5 space-y-3">
        <Skeleton className="h-3.5 w-[88%]" />
        <Skeleton className="h-3.5 w-2/5" />
      </div>
    </div>
  </div>;
}

export function ModelPickerSkeleton() {
  return <div role="status" aria-label="Loading model settings" className="ml-auto flex h-7 min-w-0 items-center gap-2 px-2.5">
    <span className="sr-only">Loading model settings…</span>
    <Skeleton className="h-3 w-32 max-w-full" />
    <Skeleton className="size-2 shrink-0 rounded-sm" />
  </div>;
}
