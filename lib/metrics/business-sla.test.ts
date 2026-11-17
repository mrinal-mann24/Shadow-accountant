import { describe, expect, it } from 'vitest'
import { messageEvents } from '@/lib/scoring'
import { addBusinessMinutes, businessMinutesBetween } from './business-time'

const TZ = 'Asia/Kolkata'
// IST is UTC+5:30. 2026-11-14 is a Saturday, 2026-11-16 a Monday.
const ist = (local: string) => new Date(`${local}+05:30`)

describe('addBusinessMinutes', () => {
  it('stays on the same day inside business hours', () => {
    expect(addBusinessMinutes(ist('2026-11-16T11:00:00'), 60, TZ).toISOString()).toBe(ist('2026-11-16T12:00:00').toISOString())
  })
  it('a Saturday 6:30 pm message with 60 minutes is due Monday 10:30 am (Sunday skipped)', () => {
    expect(addBusinessMinutes(ist('2026-11-14T18:30:00'), 60, TZ).toISOString()).toBe(ist('2026-11-16T10:30:00').toISOString())
  })
  it('a message at night is due one hour after 10 am', () => {
    expect(addBusinessMinutes(ist('2026-11-16T22:00:00'), 60, TZ).toISOString()).toBe(ist('2026-11-17T11:00:00').toISOString())
  })
  it('agrees with businessMinutesBetween', () => {
    const start = ist('2026-11-13T17:45:00')
    const due = addBusinessMinutes(start, 600, TZ)
    expect(Math.round(businessMinutesBetween(start, due, TZ))).toBe(600)
  })
  it('zero or negative minutes returns the start', () => {
    const s = ist('2026-11-16T11:00:00')
    expect(addBusinessMinutes(s, 0, TZ).getTime()).toBe(s.getTime())
  })
})

describe('messageEvents unanswered in business hours', () => {
  const run = [{ at: ist('2026-11-15T19:30:00'), direction: 'incoming' as const }] // Sunday evening
  it('a Sunday evening message is not unanswered at 9 am Monday', () => {
    expect(messageEvents(run as never, { now: ist('2026-11-16T09:00:00'), slaMinutes: 60, timezone: TZ })).toEqual([])
  })
  it('it is unanswered at 11:05 am Monday', () => {
    const ev = messageEvents(run as never, { now: ist('2026-11-16T11:05:00'), slaMinutes: 60, timezone: TZ })
    expect(ev.map((e) => e.kind)).toEqual(['unanswered'])
  })
  it('without a timezone it keeps the old wall-clock rule', () => {
    const ev = messageEvents(run as never, { now: ist('2026-11-16T09:00:00'), slaMinutes: 60 })
    expect(ev.map((e) => e.kind)).toEqual(['unanswered'])
  })
})
