// Pure date helpers for follow-ups. Safe anywhere (no server imports).
// Business days are Monday to Saturday (Sunday skipped), like lib/metrics/business-time.ts. Public holidays are
// not handled. A business day ends at 19:00 IST. India has no daylight saving, so IST is always UTC+05:30.

export const IST = 'Asia/Kolkata'
export const DAY_END = '19:00'
/** A promise with no date is due this many business days after the message. */
export const DEFAULT_DUE_BUSINESS_DAYS = 2

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

function dateFormatter(tz: string): Intl.DateTimeFormat {
  let f = dateFormatters.get(tz)
  if (!f) {
    // en-CA formats dates as YYYY-MM-DD.
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    dateFormatters.set(tz, f)
  }
  return f
}

/** True for a real calendar date written as YYYY-MM-DD (2026-02-30 is false). */
export function isYmd(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = YMD.exec(value)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

function parseIso(iso: string, label: string): number {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (Number.isNaN(ms)) throw new RangeError(`${label}: invalid date "${String(iso)}"`)
  return ms
}

function dateIn(ms: number, tz: string): string {
  return dateFormatter(tz).format(new Date(ms))
}

/** ISO instant of a wall-clock time (HH:mm) in IST on a YYYY-MM-DD date. */
function istAt(dateYmd: string, hm: string): string {
  return new Date(`${dateYmd}T${hm}:00+05:30`).toISOString()
}

/** YYYY-MM-DD of an instant in IST. Throws RangeError for an invalid date. */
export function istDate(iso: string): string {
  return dateIn(parseIso(iso, 'istDate'), IST)
}

/** ISO of 19:00 IST (end of the business day) on a YYYY-MM-DD date. Throws RangeError for an invalid date. */
export function istEndOfDay(dateYmd: string): string {
  if (!isYmd(dateYmd)) throw new RangeError(`istEndOfDay: invalid date "${String(dateYmd)}"`)
  return istAt(dateYmd, DAY_END)
}

/**
 * The date (YYYY-MM-DD, in tz) n business days after the tz date of fromIso. Sundays are skipped, so
 * Saturday + 1 = Monday and Sunday + 1 = Monday. n = 0 returns the date itself. Throws RangeError for an
 * invalid date or a negative or fractional n.
 */
export function addBusinessDays(fromIso: string, n: number, tz = IST): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`addBusinessDays: n must be a whole number >= 0, got ${n}`)
  const [y, m, d] = dateIn(parseIso(fromIso, 'addBusinessDays'), tz).split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d))
  let left = n
  while (left > 0) {
    day.setUTCDate(day.getUTCDate() + 1)
    if (day.getUTCDay() !== 0) left--
  }
  return day.toISOString().slice(0, 10)
}

/**
 * The deadline (ISO) for a promise found in a message sent at messageAt.
 *   dueDate given: that date at dueTime (HH:mm IST), or 19:00 IST when dueTime is missing or invalid. A date on
 *     a non-business day (Sunday) moves to the next business day at 19:00 IST, so it is reminded in business hours.
 *   dueDate null, invalid, before the message date, or a deadline not after the message itself:
 *     2 business days after the message date, 19:00 IST.
 * Throws RangeError only when messageAt is not a valid date.
 */
export function resolveDue(dueDate: string | null, dueTime: string | null, messageAt: string): string {
  const msgMs = parseIso(messageAt, 'resolveDue')
  const msgDate = dateIn(msgMs, IST)
  if (isYmd(dueDate) && dueDate >= msgDate) {
    if (!isBusinessDay(dueDate)) return istEndOfDay(addBusinessDays(istAt(dueDate, '12:00'), 1))
    const at = istAt(dueDate, typeof dueTime === 'string' && HM.test(dueTime) ? dueTime : DAY_END)
    if (Date.parse(at) > msgMs) return at
  }
  return istEndOfDay(addBusinessDays(messageAt, DEFAULT_DUE_BUSINESS_DAYS))
}

/** Monday to Saturday (a YYYY-MM-DD date; the weekday does not depend on the timezone). */
export function isBusinessDay(dateYmd: string): boolean {
  return new Date(`${dateYmd}T00:00:00Z`).getUTCDay() !== 0
}
