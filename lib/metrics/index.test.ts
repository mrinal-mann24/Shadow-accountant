import { describe, expect, it } from 'vitest'
import { businessMinutesBetween, computeClientMetrics, isThanks, median, type MetricMessage } from './index'

const TZ = 'Asia/Kolkata'
// 2026-11-16 is a Monday; 2026-11-21 Saturday; 2026-11-22 Sunday.
const ist = (s: string) => new Date(`${s}:00+05:30`)
const msg = (at: string, direction: 'incoming' | 'outgoing', body = 'hi'): MetricMessage => ({ at: ist(at), direction, body })

describe('businessMinutesBetween (Mon to Sat 10:00 to 19:00 IST)', () => {
  it('counts a span inside one business day', () => {
    expect(businessMinutesBetween(ist('2026-11-16T11:00'), ist('2026-11-16T12:30'), TZ)).toBe(90)
  })
  it('ignores time before opening and after closing', () => {
    expect(businessMinutesBetween(ist('2026-11-16T08:00'), ist('2026-11-16T10:30'), TZ)).toBe(30)
    expect(businessMinutesBetween(ist('2026-11-16T18:30'), ist('2026-11-16T22:00'), TZ)).toBe(30)
    expect(businessMinutesBetween(ist('2026-11-16T19:30'), ist('2026-11-16T23:00'), TZ)).toBe(0)
  })
  it('handles overnight', () => {
    expect(businessMinutesBetween(ist('2026-11-16T18:30'), ist('2026-11-17T10:15'), TZ)).toBe(45)
    expect(businessMinutesBetween(ist('2026-11-16T20:00'), ist('2026-11-17T20:00'), TZ)).toBe(540)
  })
  it('skips Sunday', () => {
    expect(businessMinutesBetween(ist('2026-11-21T18:00'), ist('2026-11-23T11:00'), TZ)).toBe(120)
    expect(businessMinutesBetween(ist('2026-11-22T11:00'), ist('2026-11-22T15:00'), TZ)).toBe(0)
    expect(businessMinutesBetween(ist('2026-11-22T12:00'), ist('2026-11-23T10:30'), TZ)).toBe(30)
  })
  it('counts Saturday as a business day', () => {
    expect(businessMinutesBetween(ist('2026-11-21T09:00'), ist('2026-11-21T20:00'), TZ)).toBe(540)
  })
  it('counts six business days in a full week', () => {
    expect(businessMinutesBetween(ist('2026-11-16T00:00'), ist('2026-11-23T00:00'), TZ)).toBe(6 * 540)
  })
  it('returns 0 when the end is not after the start', () => {
    expect(businessMinutesBetween(ist('2026-11-16T12:00'), ist('2026-11-16T12:00'), TZ)).toBe(0)
    expect(businessMinutesBetween(ist('2026-11-16T12:00'), ist('2026-11-16T11:00'), TZ)).toBe(0)
  })
  it('keeps fractional minutes', () => {
    expect(businessMinutesBetween(new Date('2026-11-16T05:30:00Z'), new Date('2026-11-16T05:30:30Z'), TZ)).toBe(0.5)
  })
  it('works in other timezones, across a DST change', () => {
    expect(businessMinutesBetween(new Date('2026-11-16T10:00:00Z'), new Date('2026-11-16T11:00:00Z'), 'UTC')).toBe(60)
    // UK clocks go forward on Sunday 29 Mar 2026. Sat 18:00 GMT to Mon 11:00 BST.
    expect(
      businessMinutesBetween(new Date('2026-03-28T18:00:00Z'), new Date('2026-03-30T10:00:00Z'), 'Europe/London'),
    ).toBe(120)
  })
  it('does not handle public holidays (counted as business days)', () => {
    // 2026-11-24 is treated as a normal Tuesday whatever the holiday calendar says.
    expect(businessMinutesBetween(ist('2026-11-24T10:00'), ist('2026-11-24T19:00'), TZ)).toBe(540)
  })
})

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe('isThanks', () => {
  it('matches whole words, case-insensitive', () => {
    for (const s of ['Thank you', 'thanks!', 'THX', 'ok tysm', 'Dhanyavad ji', 'thanks a lot', 'Thank u']) {
      expect(isThanks(s)).toBe(true)
    }
    for (const s of ['thankful', 'thanksgiving', 'hello', '', 'thankyou']) {
      expect(isThanks(s)).toBe(false)
    }
  })
})

describe('computeClientMetrics', () => {
  const now = ist('2026-11-20T12:00')

  it('returns empty metrics for no messages', () => {
    expect(computeClientMetrics([], { now, timezone: TZ })).toEqual({
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
    })
  })

  it('measures a simple reply', () => {
    const m = computeClientMetrics([msg('2026-11-16T11:00', 'incoming'), msg('2026-11-16T11:30', 'outgoing')], {
      now,
      timezone: TZ,
    })
    expect(m.firstReplyMedianMin).toBe(30)
    expect(m.firstReplyBizMedianMin).toBe(30)
    expect(m.answeredWithin7dPct).toBe(100)
    expect(m.proactivePct).toBe(0)
    expect(m.unansweredCount).toBe(0)
    expect(m.worstLagMin).toBe(30)
    expect(m.incomingCount).toBe(1)
    expect(m.outgoingCount).toBe(1)
  })

  it('measures from the first message of an incoming run and counts only the first outgoing as the reply', () => {
    const m = computeClientMetrics(
      [
        msg('2026-11-16T11:00', 'incoming'),
        msg('2026-11-16T11:10', 'incoming'),
        msg('2026-11-16T11:20', 'incoming'),
        msg('2026-11-16T11:45', 'outgoing'),
        msg('2026-11-16T11:50', 'outgoing'),
      ],
      { now, timezone: TZ },
    )
    expect(m.firstReplyMedianMin).toBe(45)
    expect(m.incomingCount).toBe(3)
    expect(m.outgoingCount).toBe(2)
    expect(m.proactivePct).toBe(0)
  })

  it('uses business minutes for the overnight business median', () => {
    const m = computeClientMetrics([msg('2026-11-16T18:50', 'incoming'), msg('2026-11-17T10:05', 'outgoing')], {
      now,
      timezone: TZ,
    })
    expect(m.firstReplyMedianMin).toBe(915)
    expect(m.firstReplyBizMedianMin).toBe(15)
    expect(m.lagsOver4h).toBe(1)
    expect(m.lagsOver24h).toBe(0)
  })

  it('takes the median over several replies', () => {
    const m = computeClientMetrics(
      [
        msg('2026-11-16T11:00', 'incoming'),
        msg('2026-11-16T11:10', 'outgoing'),
        msg('2026-11-16T12:00', 'incoming'),
        msg('2026-11-16T12:30', 'outgoing'),
        msg('2026-11-16T13:00', 'incoming'),
        msg('2026-11-16T14:00', 'outgoing'),
        msg('2026-11-16T15:00', 'incoming'),
        msg('2026-11-16T15:20', 'outgoing'),
      ],
      { now, timezone: TZ },
    )
    expect(m.firstReplyMedianMin).toBe(25) // 10, 20, 30, 60
    expect(m.worstLagMin).toBe(60)
  })

  it('counts a recent unanswered run without deciding it', () => {
    const m = computeClientMetrics([msg('2026-11-20T10:00', 'incoming'), msg('2026-11-20T10:05', 'incoming')], {
      now,
      timezone: TZ,
    })
    expect(m.unansweredCount).toBe(1)
    expect(m.answeredWithin7dPct).toBeNull()
    expect(m.firstReplyMedianMin).toBeNull()
    expect(m.worstLagMin).toBe(120)
    expect(m.lagsOver4h).toBe(0)
  })

  it('decides an unanswered run older than 7 days as not answered', () => {
    const m = computeClientMetrics(
      [
        msg('2026-11-02T11:00', 'incoming'),
        msg('2026-11-02T11:30', 'outgoing'),
        msg('2026-11-10T11:00', 'incoming'),
      ],
      { now, timezone: TZ },
    )
    expect(m.unansweredCount).toBe(1)
    expect(m.answeredWithin7dPct).toBe(50)
    expect(m.lagsOver24h).toBe(1)
    expect(m.worstLagMin).toBe(10 * 24 * 60 + 60)
  })

  it('treats a reply after more than 7 days as late and proactive', () => {
    const m = computeClientMetrics([msg('2026-11-01T11:00', 'incoming'), msg('2026-11-09T11:00', 'outgoing')], {
      now,
      timezone: TZ,
    })
    expect(m.answeredWithin7dPct).toBe(0)
    expect(m.proactivePct).toBe(100)
    expect(m.lagsOver24h).toBe(1)
  })

  it('judges proactive against the latest incoming message of the previous run', () => {
    const m = computeClientMetrics(
      [
        msg('2026-11-01T11:00', 'incoming'),
        msg('2026-11-08T11:00', 'incoming'),
        msg('2026-11-09T11:00', 'outgoing'),
      ],
      { now, timezone: TZ },
    )
    expect(m.proactivePct).toBe(0)
    expect(m.answeredWithin7dPct).toBe(0) // lag counted from the first unanswered message (8 days)
  })

  it('computes the proactive share of outgoing runs', () => {
    const m = computeClientMetrics(
      [
        msg('2026-11-16T10:00', 'outgoing', 'Please share the bank statement'),
        msg('2026-11-16T11:00', 'incoming'),
        msg('2026-11-16T11:15', 'outgoing'),
        msg('2026-11-16T11:16', 'outgoing'),
      ],
      { now, timezone: TZ },
    )
    expect(m.proactivePct).toBe(50)
    expect(m.outgoingCount).toBe(3)
  })

  it('counts thanks from clients only', () => {
    const m = computeClientMetrics(
      [
        msg('2026-11-16T11:00', 'incoming', 'Thank you so much'),
        msg('2026-11-16T11:01', 'incoming', 'thx'),
        msg('2026-11-16T11:02', 'incoming', 'I am thankful'),
        msg('2026-11-16T11:05', 'outgoing', 'Thanks!'),
      ],
      { now, timezone: TZ },
    )
    expect(m.thanksCount).toBe(2)
  })

  it('sorts input and ignores messages after now', () => {
    const m = computeClientMetrics(
      [
        msg('2026-11-16T11:30', 'outgoing'),
        msg('2026-11-16T11:00', 'incoming'),
        msg('2026-11-21T11:00', 'incoming'),
      ],
      { now, timezone: TZ },
    )
    expect(m.firstReplyMedianMin).toBe(30)
    expect(m.incomingCount).toBe(1)
    expect(m.unansweredCount).toBe(0)
  })

  it('rounds to one decimal', () => {
    const m = computeClientMetrics(
      [
        { at: new Date('2026-11-16T05:30:00Z'), direction: 'incoming', body: '' },
        { at: new Date('2026-11-16T05:30:20Z'), direction: 'outgoing', body: '' },
        { at: new Date('2026-11-16T05:40:00Z'), direction: 'outgoing', body: '' },
      ],
      { now, timezone: TZ },
    )
    expect(m.firstReplyMedianMin).toBe(0.3)
  })
})
