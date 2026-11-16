import { describe, expect, it } from 'vitest'
import type { ClientMetrics, MetricMessage } from '@/lib/metrics'
import {
  DEFAULT_WEIGHTS,
  computeHealthScore,
  dateInTimezone,
  messageEvents,
  pickPrev,
  ticketEvents,
  weightsFromRows,
  type ScoreEvent,
} from './index'

// 16 Nov 2026, 12:00 IST
const NOW = new Date('2026-11-16T06:30:00Z')
const H = 3_600_000
const D = 24 * H
const ago = (ms: number) => new Date(NOW.getTime() - ms)

function metrics(over: Partial<ClientMetrics> = {}): ClientMetrics {
  return {
    firstReplyMedianMin: null,
    firstReplyBizMedianMin: null,
    answeredWithin7dPct: null,
    proactivePct: null,
    thanksCount: 0,
    unansweredCount: 0,
    worstLagMin: null,
    lagsOver4h: 0,
    lagsOver24h: 0,
    incomingCount: 0,
    outgoingCount: 0,
    ...over,
  }
}

const lag = (ageMs: number, lagMinutes: number): ScoreEvent => ({ kind: 'lag', at: ago(ageMs), lagMinutes })
const ticket = (
  tag: string | null,
  fault: string | null,
  ageMs: number,
  o: { open?: boolean; tone?: string | null } = {},
): ScoreEvent => ({ kind: 'ticket', at: ago(ageMs), tag, fault, open: o.open ?? false, clientTone: o.tone ?? null })

function score(events: ScoreEvent[], o: { m?: Partial<ClientMetrics>; w?: Record<string, number>; prev?: { service: number; mood: number } } = {}) {
  return computeHealthScore({ metrics: metrics(o.m), events, weights: o.w ?? DEFAULT_WEIGHTS, now: NOW, prev: o.prev })
}

describe('computeHealthScore: service', () => {
  it('scores 100 with no events', () => {
    const r = score([])
    expect(r.service_score).toBe(100)
    expect(r.top_reasons).toEqual([])
    expect(r.contributions).toEqual([])
    expect(r.prev_service).toBeNull()
    expect(r.service_delta).toBeNull()
  })

  it('ignores lags of 4 hours or less', () => {
    expect(score([lag(0, 240), lag(0, 30)]).service_score).toBe(100)
  })

  it('applies lag_over_4h for a 5 hour lag', () => {
    expect(score([lag(0, 300)]).service_score).toBe(98)
  })

  it('applies both lag weights for a lag over 24 hours', () => {
    expect(score([lag(0, 30 * 60)]).service_score).toBe(92)
  })

  it('halves a penalty after one half-life', () => {
    expect(score([lag(14 * D, 30 * 60)]).service_score).toBe(96)
  })

  it('ignores lags outside the window', () => {
    expect(score([lag(31 * D, 30 * 60)]).service_score).toBe(100)
  })

  it('does not decay an unanswered run (current state)', () => {
    const r = score([{ kind: 'unanswered', at: ago(20 * D) }])
    expect(r.service_score).toBe(92)
    expect(r.unanswered_count).toBe(1)
  })

  it('weights complaints by fault', () => {
    expect(score([ticket('complaint', 'us', 0)]).service_score).toBe(95)
    expect(score([ticket('complaint', 'neither', 0)]).service_score).toBe(99)
    expect(score([ticket('complaint', 'client', 0)]).service_score).toBe(100)
  })

  it('treats a missing or unknown fault as neither', () => {
    expect(score([ticket('complaint', null, 0)]).service_score).toBe(99)
    expect(score([ticket('Complaint', 'vendor', 0)]).service_score).toBe(99)
  })

  it('uses escalation_us for our escalations and complaint weights otherwise', () => {
    expect(score([ticket('escalation', 'us', 0)]).service_score).toBe(88)
    expect(score([ticket('escalation', 'client', 0)]).service_score).toBe(100)
    expect(score([ticket('escalation', 'neither', 0)]).service_score).toBe(99)
  })

  it('decays closed tickets but not open ones', () => {
    // closed complaint 14 days ago: -2.5, rounds to 98 (97.5)
    expect(score([ticket('complaint', 'us', 14 * D)]).service_score).toBe(98)
    // open complaint 14 days ago: full -5
    expect(score([ticket('complaint', 'us', 14 * D, { open: true })]).service_score).toBe(95)
  })

  it('counts open complaints opened before the window, but not closed ones', () => {
    expect(score([ticket('escalation', 'us', 60 * D, { open: true })]).service_score).toBe(88)
    expect(score([ticket('escalation', 'us', 60 * D)]).service_score).toBe(100)
  })

  it('adds positive tickets but never above 100', () => {
    expect(score([ticket('positive', null, 0)]).service_score).toBe(100)
    expect(score([ticket('positive', null, 0), ticket('complaint', 'us', 0)]).service_score).toBe(98)
  })

  it('ignores neutral tickets for service', () => {
    expect(score([ticket('neutral', 'us', 0)]).service_score).toBe(100)
  })

  it('clamps at 0', () => {
    const many = Array.from({ length: 10 }, () => ticket('escalation', 'us', 0, { open: true }))
    expect(score(many).service_score).toBe(0)
  })

  it('respects custom weights and fills missing keys with defaults', () => {
    const r = score([ticket('complaint', 'us', 0)], { w: { complaint_us: -20 } })
    expect(r.service_score).toBe(80)
    const r2 = score([lag(7 * D, 300)], { w: { half_life_days: 7, lag_over_4h: -10 } })
    expect(r2.service_score).toBe(95)
  })
})

describe('computeHealthScore: counters', () => {
  it('counts open issues, complaints in 7 days and our fault in 7 days', () => {
    const r = score([
      ticket('complaint', 'us', 2 * D, { open: true }),
      ticket('escalation', 'client', 3 * D),
      ticket('complaint', 'us', 10 * D),
      ticket('positive', null, 1 * D, { open: true }),
      ticket('neutral', null, 1 * D, { open: true }),
    ])
    expect(r.open_issues).toBe(1)
    expect(r.complaints_7d).toBe(2)
    expect(r.our_fault_7d).toBe(1)
  })

  it('takes worst lag from metrics, falling back to the events', () => {
    expect(score([lag(0, 500)], { m: { worstLagMin: 900 } }).worst_lag_minutes).toBe(900)
    expect(score([lag(0, 500.4), lag(D, 100)]).worst_lag_minutes).toBe(500)
    expect(score([]).worst_lag_minutes).toBeNull()
  })
})

describe('computeHealthScore: mood', () => {
  it('defaults to 70 with no data', () => {
    expect(score([]).mood_score).toBe(70)
  })

  it('averages tones', () => {
    expect(score([ticket('neutral', null, 0, { tone: 'happy' }), ticket('neutral', null, 0, { tone: 'angry' })]).mood_score).toBe(55)
  })

  it('weights recent tones more', () => {
    // happy today (weight 1) + angry 14 days ago (weight 0.5) = (100 + 5) / 1.5 = 70
    const r = score([ticket('neutral', null, 0, { tone: 'happy' }), ticket('neutral', null, 14 * D, { tone: 'angry' })])
    expect(r.mood_score).toBe(70)
  })

  it('ignores unknown tones and tones outside the window', () => {
    expect(score([ticket('neutral', null, 0, { tone: 'sarcastic' })]).mood_score).toBe(70)
    expect(score([ticket('complaint', 'us', 40 * D, { tone: 'angry', open: true })]).mood_score).toBe(70)
    expect(score([ticket(null, null, 0, { tone: ' Calm ' })]).mood_score).toBe(80)
  })

  it('blends in the thanks rate when there are incoming messages', () => {
    // no tones: 0.8 * 70 + 0.2 * thanks
    expect(score([], { m: { incomingCount: 10, thanksCount: 1 } }).mood_score).toBe(76) // thanks 100
    expect(score([], { m: { incomingCount: 10, thanksCount: 0 } }).mood_score).toBe(66) // thanks 50
    expect(score([], { m: { incomingCount: 20, thanksCount: 1 } }).mood_score).toBe(71) // thanks 75
    expect(score([ticket('neutral', null, 0, { tone: 'angry' })], { m: { incomingCount: 4, thanksCount: 4 } }).mood_score).toBe(28)
  })
})

describe('computeHealthScore: prev, delta and reasons', () => {
  it('computes deltas from prev', () => {
    const r = score([ticket('complaint', 'us', 0)], { prev: { service: 90, mood: 75 } })
    expect(r.prev_service).toBe(90)
    expect(r.prev_mood).toBe(75)
    expect(r.service_delta).toBe(5)
    expect(r.mood_delta).toBe(-5)
  })

  it('lists up to 3 biggest negative contributors, grouped', () => {
    const r = score([
      { kind: 'unanswered', at: ago(H * 3) },
      lag(0, 30 * 60),
      lag(0, 26 * 60),
      ticket('escalation', 'us', 0),
      ticket('complaint', 'neither', 0),
      ticket('positive', null, 0),
    ])
    // escalation_us -12, lag_over_24h -12, unanswered -8, lag_over_4h -4, complaint_neither -1
    expect(r.top_reasons).toHaveLength(3)
    expect(r.top_reasons).toContain('1 escalation where we were at fault')
    expect(r.top_reasons).toContain('2 replies took over 24 hours')
    expect(r.top_reasons[2]).toBe('1 message waiting for a reply')
    expect(r.top_reasons.join(' ')).not.toMatch(/—/)
  })

  it('never lists zero-weight or positive contributors', () => {
    const r = score([ticket('complaint', 'client', 0), ticket('positive', null, 0)])
    expect(r.top_reasons).toEqual([])
  })

  it('reports contributions per weight key', () => {
    const r = score([lag(14 * D, 300), lag(0, 300)])
    expect(r.contributions).toEqual([{ key: 'lag_over_4h', count: 2, points: -3 }])
  })
})

describe('messageEvents', () => {
  const msg = (ageMs: number, direction: 'incoming' | 'outgoing'): MetricMessage => ({ at: ago(ageMs), direction, body: '' })

  it('measures lag from the first incoming message of a run to the next reply', () => {
    const ev = messageEvents([msg(10 * H, 'incoming'), msg(9 * H, 'incoming'), msg(4 * H, 'outgoing')], { now: NOW, slaMinutes: 60 })
    expect(ev).toEqual([{ kind: 'lag', at: ago(10 * H), lagMinutes: 360 }])
  })

  it('ignores proactive outgoing messages and sorts input', () => {
    const ev = messageEvents([msg(1 * H, 'outgoing'), msg(3 * H, 'incoming'), msg(5 * H, 'outgoing')], { now: NOW, slaMinutes: 60 })
    expect(ev).toEqual([{ kind: 'lag', at: ago(3 * H), lagMinutes: 120 }])
  })

  it('marks a trailing run unanswered only after the SLA', () => {
    expect(messageEvents([msg(2 * H, 'incoming')], { now: NOW, slaMinutes: 60 })).toEqual([{ kind: 'unanswered', at: ago(2 * H) }])
    expect(messageEvents([msg(30 * 60_000, 'incoming')], { now: NOW, slaMinutes: 60 })).toEqual([])
  })

  it('ignores messages after now', () => {
    const later = { at: new Date(NOW.getTime() + H), direction: 'outgoing' as const, body: '' }
    expect(messageEvents([msg(2 * H, 'incoming'), later], { now: NOW, slaMinutes: 60 })).toEqual([{ kind: 'unanswered', at: ago(2 * H) }])
  })

  it('returns nothing for no messages', () => {
    expect(messageEvents([], { now: NOW, slaMinutes: 60 })).toEqual([])
  })
})

describe('ticketEvents', () => {
  it('maps conversations rows', () => {
    const ev = ticketEvents([
      { tag: 'complaint', fault: 'us', status: 'Open', opened_at: '2026-11-10T00:00:00Z', client_tone: 'angry' },
      { tag: null, fault: null, status: 'closed', opened_at: '2026-11-11T00:00:00Z', client_tone: null },
    ])
    expect(ev).toEqual([
      { kind: 'ticket', at: new Date('2026-11-10T00:00:00Z'), tag: 'complaint', fault: 'us', open: true, clientTone: 'angry' },
      { kind: 'ticket', at: new Date('2026-11-11T00:00:00Z'), tag: null, fault: null, open: false, clientTone: null },
    ])
  })
})

describe('dateInTimezone', () => {
  it('uses the IST date', () => {
    expect(dateInTimezone(new Date('2026-11-15T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-16')
    expect(dateInTimezone(new Date('2026-11-15T18:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-15')
  })
})

describe('pickPrev', () => {
  const row = (computed_at: string, prev: [number | null, number | null] = [80, 60]) => ({
    service_score: 90,
    mood_score: 70,
    prev_service: prev[0],
    prev_mood: prev[1],
    computed_at,
  })

  it('returns undefined with no row', () => {
    expect(pickPrev(null, NOW, 'Asia/Kolkata')).toBeUndefined()
  })

  it('uses the row scores when computed on an earlier day', () => {
    expect(pickPrev(row('2026-11-15T06:30:00Z'), NOW, 'Asia/Kolkata')).toEqual({ service: 90, mood: 70 })
  })

  it('keeps the row prev when re-running on the same IST day', () => {
    // 01:30 IST on 16 Nov
    expect(pickPrev(row('2026-11-15T20:00:00Z'), NOW, 'Asia/Kolkata')).toEqual({ service: 80, mood: 60 })
    expect(pickPrev(row('2026-11-15T20:00:00Z', [null, null]), NOW, 'Asia/Kolkata')).toBeUndefined()
  })
})

describe('weightsFromRows', () => {
  it('overrides defaults with rows and keeps missing keys', () => {
    const w = weightsFromRows([{ key: 'unanswered', value: -10 }])
    expect(w.unanswered).toBe(-10)
    expect(w.window_days).toBe(30)
  })
})
