// Pure display helpers for the Admin and Engineer screens. Client-safe, unit tested.

export const DEFAULT_TIMEZONE = 'Asia/Kolkata'

/** "16 Nov 2026, 3:04 pm" in the app timezone, or "Never" when missing / invalid. */
export function formatDateTime(iso: string | null | undefined, timezone = DEFAULT_TIMEZONE): string {
  const d = parseDate(iso)
  if (!d) return 'Never'
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

/** "just now", "12 min ago", "3 h ago", "2 days ago", or "Never". Future times read as "just now". */
export function formatAgo(iso: string | null | undefined, now: Date): string {
  const d = parseDate(iso)
  if (!d) return 'Never'
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/** True when the time is missing or older than maxMinutes. */
export function isStale(iso: string | null | undefined, now: Date, maxMinutes: number): boolean {
  const d = parseDate(iso)
  if (!d) return true
  return now.getTime() - d.getTime() > maxMinutes * 60_000
}

/** "45 min", "5.5 h", "3 days", or "None". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return 'None'
  if (minutes < 60) return `${Math.round(minutes)} min`
  const hours = minutes / 60
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`
  return `${Math.round(hours / 24)} days`
}

/** Whole number, or "Not scored". */
export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'Not scored'
  return String(Math.round(score))
}

/** Text colour class for a 0 to 100 health score: red below 50, amber below 70. */
export function scoreClass(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'text-muted-foreground'
  if (score < 50) return 'text-destructive'
  if (score < 70) return 'text-warning'
  return 'text-foreground'
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}
