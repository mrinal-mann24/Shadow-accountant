// Read-only bucket display with a disabled switch until bucket storage is approved (lib/buckets).
import { BUCKET_STORAGE_APPROVED, BUCKETS } from '@/lib/buckets'
import { NO_BUCKET_LABEL } from './logic'

export function BucketControl({ bucket }: { bucket: string | null }) {
  const current = BUCKETS.find((b) => b.key === bucket)
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Current bucket</span>
        <span
          className={
            current || bucket
              ? 'rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-accent-foreground'
              : 'rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground'
          }
        >
          {current?.label ?? bucket ?? NO_BUCKET_LABEL}
        </span>
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={false}
          aria-describedby="bucket-help"
          disabled
          className="relative inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full bg-input opacity-60"
        >
          <span className="sr-only">Change bucket</span>
          <span className="ml-0.5 size-4 rounded-full bg-background shadow-sm" />
        </button>
        <span className="text-muted-foreground">Change bucket</span>
      </div>
      <p id="bucket-help" className="text-xs text-muted-foreground">
        {BUCKET_STORAGE_APPROVED
          ? 'Bucket changes sync to HubSpot.'
          : 'Bucket changes are not live yet. Storing buckets needs approval first; once approved, changes here will sync to HubSpot.'}
      </p>
      <p className="text-xs text-muted-foreground">
        Planned buckets: {BUCKETS.map((b) => b.label).join(', ')} (meanings to be confirmed).
      </p>
    </div>
  )
}
