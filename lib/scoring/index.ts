// Health score (pure). Replaces the dormant old score; keeps its tables and score_weights keys.
//
// SERVICE SCORE
//   service_score = clamp(100 + sum(weight * decay(age)), 0, 100), rounded to a whole number
//   decay(age)    = 0.5 ^ (ageDays / half_life_days)
//   Events counted (only within window_days, except "current state" events, see below):
//   - every reply lag over 4h adds lag_over_4h; a lag over 24h also adds lag_over_24h (so a 30h lag = -2 + -6).
//     Lags are wall-clock (not business time). Age = time since the client's first unanswered message in that run.
//   - every currently unanswered incoming run (older than sla_minutes) adds `unanswered`, with NO decay:
//     it is a current state, not history.
//   - every complaint ticket adds complaint_<fault> (fault us / neither / client; unknown fault counts as neither).
//   - every escalation ticket at our fault adds escalation_us; escalations with another fault count as complaint_<fault>.
//     Tickets that are still open get NO decay (current state); closed tickets decay by age since opened_at.
//     Open tickets count even when opened before the window.
//   - every positive ticket adds `positive` (decayed).
//
// MOOD SCORE
//   toneAvg   = decay-weighted average of conversations.client_tone in the window
//               (happy 100, calm 80, neutral 60, frustrated 30, angry 10; unknown tones ignored); 70 when none.
//   thanks    = 50 + 500 * (thanksCount / incomingCount), capped at 100 (a 10% thanks rate scores 100).
//   mood      = 0.8 * toneAvg + 0.2 * thanks when there are incoming messages, else toneAvg.
//   No tones and no incoming messages gives the default 70.
//
// prev / delta: prev comes from the existing client_scores row (see pickPrev), delta = score - prev.
// top_reasons: up to 3 short reasons for the biggest negative contributors, grouped by kind.
import type { ClientMetrics, MetricMessage } from '@/lib/metrics'
import { businessMinutesBetween } from '@/lib/metrics/business-time'

export const DEFAULT_WEIGHTS: Record<string, number> = {
  window_days: 30,
  half_life_days: 14,
  lag_over_4h: -2,
  lag_over_24h: -6,
  unanswered: -8,
  complaint_us: -5,
  complaint_neither: -1,
  complaint_client: 0,
  escalation_us: -12,
  positive: 3,
}

export const TONE_SCORES: Record<string, number> = {
  happy: 100,
  calm: 80,
  neutral: 60,
  frustrated: 30,
  angry: 10,
}

const DEFAULT_MOOD = 70
const DAY_MS = 86_400_000

export type ScoreEvent =
  | { kind: 'lag'; at: Date; lagMinutes: number }
  | { kind: 'unanswered'; at: Date }
  | {
      kind: 'ticket'
      at: Date // conversations.opened_at
      tag: string | null // escalation / complaint / neutral / positive
      fault: string | null // us / neither / client
      open: boolean
      clientTone: string | null
    }

export type Contribution = { key: string; count: number; points: number }

export type HealthScoreResult = {
  service_score: number
  mood_score: number
  prev_service: number | null
  prev_mood: number | null
  service_delta: number | null
  mood_delta: number | null
  open_issues: number
  complaints_7d: number
  our_fault_7d: number
  unanswered_count: number
  worst_lag_minutes: number | null
  top_reasons: string[]
  /** Per weight key: how many events and the decayed points they added. For dry-run review. */
  contributions: Contribution[]
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function weight(weights: Record<string, number>, key: string): number {
  const v = weights[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_WEIGHTS[key]
}

function normFault(fault: string | null): 'us' | 'neither' | 'client' {
  const f = (fault ?? '').trim().toLowerCase()
  return f === 'us' || f === 'client' ? f : 'neither'
}

function isNegativeTag(tag: string | null): tag is 'complaint' | 'escalation' {
  const t = (tag ?? '').trim().toLowerCase()
  return t === 'complaint' || t === 'escalation'
}

/** Weight key a ticket adds, or null when it adds nothing to service. */
function ticketKey(tag: string | null, fault: string | null): string | null {
  const t = (tag ?? '').trim().toLowerCase()
  const f = normFault(fault)
  if (t === 'escalation') return f === 'us' ? 'escalation_us' : `complaint_${f}`
  if (t === 'complaint') return `complaint_${f}`
  if (t === 'positive') return 'positive'
  return null
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function reasonText(c: Contribution): string {
  switch (c.key) {
    case 'lag_over_24h':
      return `${plural(c.count, 'reply', 'replies')} took over 24 hours`
    case 'lag_over_4h':
      return `${plural(c.count, 'reply', 'replies')} took over 4 hours`
    case 'unanswered':
      return `${plural(c.count, 'message', 'messages')} waiting for a reply`
    case 'escalation_us':
      return `${plural(c.count, 'escalation', 'escalations')} where we were at fault`
    case 'complaint_us':
      return `${plural(c.count, 'complaint', 'complaints')} where we were at fault`
    case 'complaint_neither':
      return `${plural(c.count, 'complaint', 'complaints')} with no clear fault`
    case 'complaint_client':
      return `${plural(c.count, 'complaint', 'complaints')} from the client side`
    default:
      return `${plural(c.count, 'event', 'events')} (${c.key})`
  }
}

export function computeHealthScore(input: {
  metrics: ClientMetrics
  events: ScoreEvent[]
  weights: Record<string, number>
  now: Date
  prev?: { service: number; mood: number }
}): HealthScoreResult {
  const { metrics, events, weights, now, prev } = input
  const windowDays = Math.max(1, weight(weights, 'window_days'))
  const halfLife = Math.max(0.0001, weight(weights, 'half_life_days'))
  const nowMs = now.getTime()

  const ageDays = (at: Date) => Math.max(0, (nowMs - at.getTime()) / DAY_MS)
  const decay = (at: Date) => Math.pow(0.5, ageDays(at) / halfLife)
  const inWindow = (at: Date) => ageDays(at) <= windowDays

  const contrib = new Map<string, Contribution>()
  const add = (key: string, factor: number) => {
    const c = contrib.get(key) ?? { key, count: 0, points: 0 }
    c.count += 1
    c.points += weight(weights, key) * factor
    contrib.set(key, c)
  }

  let toneSum = 0
  let toneWeight = 0
  let openIssues = 0
  let complaints7d = 0
  let ourFault7d = 0
  let unanswered = 0
  let ownWorstLag: number | null = null

  for (const e of events) {
    if (e.kind === 'lag') {
      if (!inWindow(e.at)) continue
      ownWorstLag = Math.max(ownWorstLag ?? 0, e.lagMinutes)
      if (e.lagMinutes > 4 * 60) add('lag_over_4h', decay(e.at))
      if (e.lagMinutes > 24 * 60) add('lag_over_24h', decay(e.at))
    } else if (e.kind === 'unanswered') {
      // Current state: no decay, counted even if the run began before the window.
      unanswered += 1
      add('unanswered', 1)
    } else {
      const negative = isNegativeTag(e.tag)
      const currentNegative = negative && e.open
      if (!inWindow(e.at) && !currentNegative) continue

      if (currentNegative) openIssues += 1
      if (negative && ageDays(e.at) <= 7) {
        complaints7d += 1
        if (normFault(e.fault) === 'us') ourFault7d += 1
      }

      const key = ticketKey(e.tag, e.fault)
      if (key) add(key, currentNegative ? 1 : decay(e.at))

      const tone = TONE_SCORES[(e.clientTone ?? '').trim().toLowerCase()]
      if (tone !== undefined && inWindow(e.at)) {
        const w = decay(e.at)
        toneSum += tone * w
        toneWeight += w
      }
    }
  }

  const contributions = [...contrib.values()].map((c) => ({ ...c, points: Math.round(c.points * 100) / 100 }))
  const totalPoints = [...contrib.values()].reduce((s, c) => s + c.points, 0)
  const service = Math.round(clamp(100 + totalPoints, 0, 100))

  const toneAvg = toneWeight > 0 ? toneSum / toneWeight : DEFAULT_MOOD
  let moodRaw = toneAvg
  if (metrics.incomingCount > 0) {
    const thanksRate = metrics.thanksCount / metrics.incomingCount
    const thanks = Math.min(100, 50 + 500 * thanksRate)
    moodRaw = 0.8 * toneAvg + 0.2 * thanks
  }
  const mood = Math.round(clamp(moodRaw, 0, 100))

  const top_reasons = [...contrib.values()]
    .filter((c) => c.points < 0)
    .sort((a, b) => a.points - b.points)
    .slice(0, 3)
    .map(reasonText)

  return {
    service_score: service,
    mood_score: mood,
    prev_service: prev ? prev.service : null,
    prev_mood: prev ? prev.mood : null,
    service_delta: prev ? service - prev.service : null,
    mood_delta: prev ? mood - prev.mood : null,
    open_issues: openIssues,
    complaints_7d: complaints7d,
    our_fault_7d: ourFault7d,
    unanswered_count: unanswered,
    worst_lag_minutes: metrics.worstLagMin ?? (ownWorstLag === null ? null : Math.round(ownWorstLag)),
    top_reasons,
    contributions,
  }
}

/**
 * Lag and unanswered events from a client's messages (direction must already be the effective one).
 * A "run" is one or more incoming messages after our last outgoing message. The first outgoing message
 * after a run ends it: lag = that reply time - first incoming time of the run (wall-clock minutes).
 * Outgoing messages with no run before them are proactive and add nothing.
 * A run still open at `now` is unanswered once slaMinutes have passed since its first message: business minutes
 * (Mon to Sat 10:00 to 19:00) when `timezone` is given, so an evening or Sunday message is not unanswered overnight.
 */
export function messageEvents(
  msgs: MetricMessage[],
  opts: { now: Date; slaMinutes: number; timezone?: string },
): ScoreEvent[] {
  const nowMs = opts.now.getTime()
  const sorted = msgs.filter((m) => m.at.getTime() <= nowMs).sort((a, b) => a.at.getTime() - b.at.getTime())
  const events: ScoreEvent[] = []
  let runStart: Date | null = null
  for (const m of sorted) {
    if (m.direction === 'incoming') {
      if (!runStart) runStart = m.at
    } else if (runStart) {
      events.push({ kind: 'lag', at: runStart, lagMinutes: (m.at.getTime() - runStart.getTime()) / 60_000 })
      runStart = null
    }
  }
  const waited = (start: Date) =>
    opts.timezone ? businessMinutesBetween(start, opts.now, opts.timezone) : (nowMs - start.getTime()) / 60_000
  if (runStart && waited(runStart) >= opts.slaMinutes) {
    events.push({ kind: 'unanswered', at: runStart })
  }
  return events
}

/** Ticket events from conversations rows. */
export function ticketEvents(
  rows: { tag: string | null; fault: string | null; status: string; opened_at: string; client_tone: string | null }[],
): ScoreEvent[] {
  return rows.map((r) => ({
    kind: 'ticket',
    at: new Date(r.opened_at),
    tag: r.tag,
    fault: r.fault,
    open: r.status.trim().toLowerCase() === 'open',
    clientTone: r.client_tone,
  }))
}

/** YYYY-MM-DD of `d` in the given IANA timezone. */
export function dateInTimezone(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

/**
 * Previous scores for the delta. If the existing row was computed earlier today (same local date), the job
 * is re-running: keep that row's own prev so the delta stays "since the last day". Otherwise the row itself is prev.
 */
export function pickPrev(
  row:
    | { service_score: number; mood_score: number; prev_service: number | null; prev_mood: number | null; computed_at: string }
    | null
    | undefined,
  now: Date,
  timezone: string,
): { service: number; mood: number } | undefined {
  if (!row) return undefined
  const sameDay = dateInTimezone(new Date(row.computed_at), timezone) === dateInTimezone(now, timezone)
  if (!sameDay) return { service: row.service_score, mood: row.mood_score }
  if (row.prev_service === null || row.prev_mood === null) return undefined
  return { service: row.prev_service, mood: row.prev_mood }
}

/** score_weights rows to a weights record, defaults filled for missing keys. */
export function weightsFromRows(rows: { key: string; value: number }[]): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_WEIGHTS }
  for (const r of rows) if (Number.isFinite(Number(r.value))) out[r.key] = Number(r.value)
  return out
}
