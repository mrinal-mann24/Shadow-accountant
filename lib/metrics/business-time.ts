// Business-hours arithmetic. Business hours: Monday to Saturday, 10:00 to 19:00 in the given timezone.
// Public holidays are NOT handled (they count as business days).

export const BUSINESS_START_HOUR = 10
export const BUSINESS_END_HOUR = 19

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timezone, f)
  }
  return f
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

function localParts(ms: number, timezone: string): LocalParts {
  const parts: Record<string, number> = {}
  for (const p of formatter(timezone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

/** Offset of the timezone from UTC at instant `ms`, in milliseconds (IST = +19 800 000). */
function offsetAt(ms: number, timezone: string): number {
  const p = localParts(ms, timezone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** UTC instant for a wall-clock time in the timezone. */
function zonedToUtc(year: number, month: number, day: number, hour: number, timezone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour)
  const first = guess - offsetAt(guess, timezone)
  return guess - offsetAt(first, timezone)
}

/**
 * Minutes between a and b that fall inside business hours (Mon to Sat 10:00 to 19:00 local).
 * Returns 0 when b is not after a. Fractional minutes are kept.
 */
export function businessMinutesBetween(a: Date, b: Date, timezone: string): number {
  const start = a.getTime()
  const end = b.getTime()
  if (!(end > start)) return 0

  const first = localParts(start, timezone)
  // Walk local calendar days from a's local date to b's local date.
  let cursor = Date.UTC(first.year, first.month - 1, first.day)
  let total = 0
  for (let guard = 0; guard < 100_000; guard++) {
    const d = new Date(cursor)
    const y = d.getUTCFullYear()
    const m = d.getUTCMonth() + 1
    const day = d.getUTCDate()
    const winStart = zonedToUtc(y, m, day, BUSINESS_START_HOUR, timezone)
    if (winStart >= end) break
    if (d.getUTCDay() !== 0) {
      const winEnd = zonedToUtc(y, m, day, BUSINESS_END_HOUR, timezone)
      const overlap = Math.min(end, winEnd) - Math.max(start, winStart)
      if (overlap > 0) total += overlap
    }
    cursor += 86_400_000
  }
  return total / 60_000
}

/**
 * The moment `minutes` business minutes after `start` (Mon to Sat 10:00 to 19:00 local), to the millisecond.
 * Example: a message at 18:30 on Saturday with 60 minutes is due at 10:30 on Monday.
 * Built on businessMinutesBetween (monotonic in its end), so both always agree.
 */
export function addBusinessMinutes(start: Date, minutes: number, timezone: string): Date {
  if (!(minutes > 0)) return new Date(start.getTime())
  let lo = start.getTime()
  // Upper bound: grow by a week at a time (each week has 54 business hours).
  let hi = lo + minutes * 60_000
  for (let i = 0; i < 1000 && businessMinutesBetween(start, new Date(hi), timezone) < minutes; i++) hi += 7 * 86_400_000
  // Binary search to the millisecond: hi is always a moment where at least `minutes` have passed.
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (businessMinutesBetween(start, new Date(mid), timezone) >= minutes) hi = mid
    else lo = mid
  }
  return new Date(hi)
}
