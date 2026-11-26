// Pure helpers for the Home header and KPI row. Server-safe (no 'use client'), unit tested. Times are IST.

const TZ = 'Asia/Kolkata'

function istParts(now: Date, o: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...o }).formatToParts(now)) out[p.type] = p.value
  return out
}

/** "Thursday, 26 November" in IST. */
export function istDateLine(now: Date): string {
  const p = istParts(now, { weekday: 'long', day: 'numeric', month: 'long' })
  return `${p.weekday}, ${p.day} ${p.month}`
}

/** "Good morning" before 12, "Good afternoon" before 5 pm, else "Good evening" (IST). */
export function greeting(now: Date): string {
  const hour = Number(istParts(now, { hour: '2-digit', hourCycle: 'h23' }).hour)
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * One line under the greeting, from the most pressing real number: clients waiting for a reply, then SLA
 * breaches, then follow-ups due, then open tickets. `followUpsDue` null means follow-ups could not be loaded.
 */
export function homeNudge(o: {
  waitingClients: number
  firstWaitingClient: string | null
  slaBreached: number
  followUpsDue: number | null
  openTickets: number
}): string {
  if (o.waitingClients > 0) {
    const head = `${count(o.waitingClients, 'client is', 'clients are')} waiting on your team.`
    return o.firstWaitingClient ? `${head} Start with ${o.firstWaitingClient}.` : head
  }
  if (o.slaBreached > 0) return `${count(o.slaBreached, 'open ticket is', 'open tickets are')} past SLA.`
  if (o.followUpsDue) return `${count(o.followUpsDue, 'follow-up is', 'follow-ups are')} due.`
  if (o.openTickets > 0) return `No client is waiting. ${count(o.openTickets, 'open ticket', 'open tickets')} to work through.`
  return 'Nothing is waiting on you right now.'
}

/** Missed items, and open items whose due time has passed. Same rule as the "Overdue" badge on follow-ups. */
export function countOverdue(items: { status: string; dueAt: string | null }[], now: Date): number {
  return items.filter((f) => {
    if (f.status === 'missed') return true
    const due = f.dueAt ? Date.parse(f.dueAt) : NaN
    return !Number.isNaN(due) && due <= now.getTime()
  }).length
}
