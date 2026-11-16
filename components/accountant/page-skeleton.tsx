import { Skeleton } from '@/components/ui/skeleton'

/** Loading state shared by the accountant routes. */
export function PageSkeleton({ kpis = false }: { kpis?: boolean }) {
  return (
    <div className="mx-auto max-w-6xl" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading...</span>
      <Skeleton className="mb-2 h-8 w-56" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      {kpis && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    </div>
  )
}
