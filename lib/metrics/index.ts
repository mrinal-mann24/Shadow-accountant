// Pure WhatsApp service metrics for one client. No I/O; safe anywhere.
//
// Definitions (the direction passed in must already be the effective direction, see lib/team):
// - Run: consecutive messages with the same direction, in time order.
// - Reply: the first outgoing message after one or more incoming messages. Its lag is measured from the
//   first message of that incoming run (the first unanswered incoming message).
// - Unanswered: an incoming run with no outgoing message after it yet. Because runs alternate, only the
//   last run can be unanswered, so unansweredCount is 0 or 1 per client.
// - Answered within 7 days: replies with lag <= 7 days, over all runs that are decided (answered, or still
//   unanswered and older than 7 days). Runs younger than 7 days with no reply yet are left out.
// - Proactive: an outgoing run that is not a reply within 7 days, i.e. it is the first run ever or the
//   latest incoming message before it is more than 7 days older. Share of all outgoing runs.
// - Thanks: incoming messages matching thank / thanks / thx / tysm / dhanyavad as whole words.
// - Lags (worst, over 4 h, over 24 h) are wall-clock and include the current wait of an unanswered run.
// - Percentages are 0 to 100; minutes and percentages are rounded to one decimal.

import { businessMinutesBetween } from './business-time'

export { businessMinutesBetween } from './business-time'

export type MetricMessage = { at: Date; direction: 'incoming' | 'outgoing'; body: string }

export type ClientMetrics = {
  firstReplyMedianMin: number | null
  firstReplyBizMedianMin: number | null
  answeredWithin7dPct: number | null
  proactivePct: number | null
  thanksCount: number
  unansweredCount: number
  worstLagMin: number | null
  lagsOver4h: number
  lagsOver24h: number
  incomingCount: number
  outgoingCount: number
}

const MINUTE = 60_000
const SEVEN_DAYS_MIN = 7 * 24 * 60
export const THANKS_PATTERN = /\b(?:thanks?|thx|tysm|dhanyavad)\b/i

type Run = { direction: 'incoming' | 'outgoing'; first: number; last: number }

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function isThanks(body: string): boolean {
  return THANKS_PATTERN.test(body)
}

function buildRuns(msgs: { t: number; direction: 'incoming' | 'outgoing' }[]): Run[] {
  const runs: Run[] = []
  for (const m of msgs) {
    const last = runs[runs.length - 1]
    if (last && last.direction === m.direction) last.last = m.t
    else runs.push({ direction: m.direction, first: m.t, last: m.t })
  }
  return runs
}

export function computeClientMetrics(msgs: MetricMessage[], opts: { now: Date; timezone: string }): ClientMetrics {
  const nowMs = opts.now.getTime()
  const sorted = msgs
    .map((m) => ({ t: m.at.getTime(), direction: m.direction, body: m.body ?? '' }))
    .filter((m) => Number.isFinite(m.t) && m.t <= nowMs)
    .sort((a, b) => a.t - b.t)

  let incomingCount = 0
  let outgoingCount = 0
  let thanksCount = 0
  for (const m of sorted) {
    if (m.direction === 'incoming') {
      incomingCount++
      if (isThanks(m.body)) thanksCount++
    } else {
      outgoingCount++
    }
  }

  const runs = buildRuns(sorted)
  const lags: number[] = []
  const bizLags: number[] = []
  let decided = 0
  let within7d = 0
  let outgoingRuns = 0
  let proactiveRuns = 0
  let unansweredCount = 0
  let openLag: number | null = null

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const prev = i > 0 ? runs[i - 1] : null
    const next = i + 1 < runs.length ? runs[i + 1] : null

    if (run.direction === 'incoming') {
      if (next) {
        const lag = (next.first - run.first) / MINUTE
        lags.push(lag)
        bizLags.push(businessMinutesBetween(new Date(run.first), new Date(next.first), opts.timezone))
        decided++
        if (lag <= SEVEN_DAYS_MIN) within7d++
      } else {
        unansweredCount++
        openLag = (nowMs - run.first) / MINUTE
        if (openLag > SEVEN_DAYS_MIN) decided++
      }
    } else {
      outgoingRuns++
      const isReply = prev !== null && (run.first - prev.last) / MINUTE <= SEVEN_DAYS_MIN
      if (!isReply) proactiveRuns++
    }
  }

  const allLags = openLag === null ? lags : [...lags, openLag]
  const firstReplyMedian = median(lags)
  const firstReplyBizMedian = median(bizLags)

  return {
    firstReplyMedianMin: firstReplyMedian === null ? null : round1(firstReplyMedian),
    firstReplyBizMedianMin: firstReplyBizMedian === null ? null : round1(firstReplyBizMedian),
    answeredWithin7dPct: decided === 0 ? null : round1((within7d / decided) * 100),
    proactivePct: outgoingRuns === 0 ? null : round1((proactiveRuns / outgoingRuns) * 100),
    thanksCount,
    unansweredCount,
    worstLagMin: allLags.length === 0 ? null : round1(Math.max(...allLags)),
    lagsOver4h: allLags.filter((l) => l > 4 * 60).length,
    lagsOver24h: allLags.filter((l) => l > 24 * 60).length,
    incomingCount,
    outgoingCount,
  }
}
