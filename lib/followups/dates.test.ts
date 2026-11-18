import { describe, expect, it } from 'vitest'
import { addBusinessDays, isBusinessDay, istDate, istEndOfDay, isYmd, resolveDue } from './dates'

// Calendar used below: 2026-11-18 Wed, 2026-11-21 Sat, 2026-11-22 Sun, 2026-11-28 Sat, 2026-11-30 Mon,
// 2026-12-31 Thu, 2027-01-02 Sat.

describe('istDate', () => {
  it('returns the IST calendar date, not the UTC one', () => {
    expect(istDate('2026-11-18T05:00:00Z')).toBe('2026-11-18')
    expect(istDate('2026-11-18T18:29:59Z')).toBe('2026-11-18') // 23:59:59 IST
    expect(istDate('2026-11-18T18:30:00Z')).toBe('2026-11-19') // 00:00 IST next day
    expect(istDate('2026-11-18T23:30:00+05:30')).toBe('2026-11-18')
  })

  it('throws on an invalid date', () => {
    expect(() => istDate('not a date')).toThrow(RangeError)
    expect(() => istDate('')).toThrow(RangeError)
  })
})

describe('istEndOfDay', () => {
  it('is 19:00 IST (13:30 UTC) on that date', () => {
    expect(istEndOfDay('2026-11-18')).toBe('2026-11-18T13:30:00.000Z')
    expect(istEndOfDay('2026-12-31')).toBe('2026-12-31T13:30:00.000Z')
  })

  it('throws on an invalid or impossible date', () => {
    expect(() => istEndOfDay('2026-02-30')).toThrow(RangeError)
    expect(() => istEndOfDay('18-11-2026')).toThrow(RangeError)
    expect(() => istEndOfDay('2026-11-18T10:00:00Z')).toThrow(RangeError)
  })
})

describe('isYmd', () => {
  it('accepts only real dates', () => {
    expect(isYmd('2028-02-29')).toBe(true)
    expect(isYmd('2027-02-29')).toBe(false)
    expect(isYmd('2026-13-01')).toBe(false)
    expect(isYmd(null)).toBe(false)
  })
})

describe('addBusinessDays', () => {
  it('counts Monday to Saturday and skips Sunday', () => {
    expect(addBusinessDays('2026-11-18T06:00:00Z', 1)).toBe('2026-11-19')
    expect(addBusinessDays('2026-11-18T06:00:00Z', 2)).toBe('2026-11-20')
    expect(addBusinessDays('2026-11-18T06:00:00Z', 3)).toBe('2026-11-21') // Saturday counts
    expect(addBusinessDays('2026-11-18T06:00:00Z', 4)).toBe('2026-11-23') // Sunday skipped
  })

  it('from Saturday and from Sunday, the next business day is Monday', () => {
    expect(addBusinessDays('2026-11-21T06:00:00Z', 1)).toBe('2026-11-23')
    expect(addBusinessDays('2026-11-22T06:00:00Z', 1)).toBe('2026-11-23')
    expect(addBusinessDays('2026-11-22T06:00:00Z', 2)).toBe('2026-11-24')
  })

  it('n = 0 returns the date itself', () => {
    expect(addBusinessDays('2026-11-22T06:00:00Z', 0)).toBe('2026-11-22')
  })

  it('crosses month and year ends', () => {
    expect(addBusinessDays('2026-11-28T06:00:00Z', 1)).toBe('2026-11-30')
    expect(addBusinessDays('2026-12-31T06:00:00Z', 2)).toBe('2027-01-02')
    expect(addBusinessDays('2026-12-31T06:00:00Z', 3)).toBe('2027-01-04')
    expect(addBusinessDays('2028-02-28T06:00:00Z', 1)).toBe('2028-02-29')
  })

  it('starts from the IST date: 23:30 IST is still the same day, 00:30 IST is the next', () => {
    expect(addBusinessDays('2026-11-18T18:00:00Z', 1)).toBe('2026-11-19') // 23:30 IST Wed
    expect(addBusinessDays('2026-11-18T19:00:00Z', 1)).toBe('2026-11-20') // 00:30 IST Thu
  })

  it('honours another timezone', () => {
    // 2026-11-18T02:00Z is still 17 Nov in New York.
    expect(addBusinessDays('2026-11-18T02:00:00Z', 1, 'America/New_York')).toBe('2026-11-18')
  })

  it('throws on invalid input', () => {
    expect(() => addBusinessDays('nope', 1)).toThrow(RangeError)
    expect(() => addBusinessDays('2026-11-18T06:00:00Z', -1)).toThrow(RangeError)
    expect(() => addBusinessDays('2026-11-18T06:00:00Z', 1.5)).toThrow(RangeError)
  })
})

describe('resolveDue', () => {
  const wedMorning = '2026-11-18T05:00:00Z' // 10:30 IST Wed

  it('uses the given date at the given time (IST)', () => {
    expect(resolveDue('2026-11-19', '11:00', wedMorning)).toBe('2026-11-19T05:30:00.000Z')
    expect(resolveDue('2026-11-18', '17:30', wedMorning)).toBe('2026-11-18T12:00:00.000Z')
  })

  it('uses 19:00 IST when the time is missing or invalid', () => {
    expect(resolveDue('2026-11-19', null, wedMorning)).toBe('2026-11-19T13:30:00.000Z')
    expect(resolveDue('2026-11-19', '25:00', wedMorning)).toBe('2026-11-19T13:30:00.000Z')
    expect(resolveDue('2026-11-19', '5 pm', wedMorning)).toBe('2026-11-19T13:30:00.000Z')
  })

  it('no date: 2 business days after the message, 19:00 IST', () => {
    expect(resolveDue(null, null, wedMorning)).toBe('2026-11-20T13:30:00.000Z')
    expect(resolveDue(null, '11:00', wedMorning)).toBe('2026-11-20T13:30:00.000Z')
  })

  it('no date on a Friday or Saturday skips Sunday', () => {
    expect(resolveDue(null, null, '2026-11-20T05:00:00Z')).toBe('2026-11-23T13:30:00.000Z') // Fri -> Mon
    expect(resolveDue(null, null, '2026-11-21T05:00:00Z')).toBe('2026-11-24T13:30:00.000Z') // Sat -> Tue
    expect(resolveDue(null, null, '2026-11-22T05:00:00Z')).toBe('2026-11-24T13:30:00.000Z') // Sun -> Tue
  })

  it('no date across month end', () => {
    expect(resolveDue(null, null, '2026-11-28T05:00:00Z')).toBe('2026-12-01T13:30:00.000Z') // Sat 28 -> Tue 1
  })

  it('a message at 23:30 IST counts from its IST date', () => {
    const late = '2026-11-18T18:00:00Z' // 23:30 IST Wed (UTC date is also 18th)
    expect(resolveDue(null, null, late)).toBe('2026-11-20T13:30:00.000Z')
    // "today" at 23:30 is already past 19:00, so it falls back to the default.
    expect(resolveDue('2026-11-18', null, late)).toBe('2026-11-20T13:30:00.000Z')
    expect(resolveDue('2026-11-19', null, late)).toBe('2026-11-19T13:30:00.000Z')
  })

  it('a message just after IST midnight uses the new IST date', () => {
    const early = '2026-11-18T19:00:00Z' // 00:30 IST Thu 19th (UTC still 18th)
    expect(resolveDue(null, null, early)).toBe('2026-11-21T13:30:00.000Z')
    // 18th is before the message date in IST, so it is ignored.
    expect(resolveDue('2026-11-18', null, early)).toBe('2026-11-21T13:30:00.000Z')
  })

  it('a date before the message date is treated as no date', () => {
    expect(resolveDue('2026-11-17', '11:00', wedMorning)).toBe('2026-11-20T13:30:00.000Z')
  })

  it('a time earlier than the message on the same day is treated as no date', () => {
    expect(resolveDue('2026-11-18', '09:00', wedMorning)).toBe('2026-11-20T13:30:00.000Z')
  })

  it('an invalid date is treated as no date', () => {
    expect(resolveDue('2026-02-30', null, wedMorning)).toBe('2026-11-20T13:30:00.000Z')
    expect(resolveDue('tomorrow', '11:00', wedMorning)).toBe('2026-11-20T13:30:00.000Z')
    expect(resolveDue('', null, wedMorning)).toBe('2026-11-20T13:30:00.000Z')
  })

  it('a deadline on a Sunday moves to Monday 19:00 IST', () => {
    const satAfternoon = '2026-11-21T11:30:00Z' // 17:00 IST Sat
    expect(resolveDue('2026-11-22', null, satAfternoon)).toBe('2026-11-23T13:30:00.000Z') // Saturday "tomorrow" -> Monday
    expect(resolveDue('2026-11-22', '11:00', satAfternoon)).toBe('2026-11-23T13:30:00.000Z') // the Sunday time is dropped
    expect(resolveDue('2026-11-29', null, wedMorning)).toBe('2026-11-30T13:30:00.000Z')
    // A message sent on Sunday about "today" also lands on Monday.
    expect(resolveDue('2026-11-22', null, '2026-11-22T05:00:00Z')).toBe('2026-11-23T13:30:00.000Z')
    // Saturday stays a business day.
    expect(resolveDue('2026-11-21', null, wedMorning)).toBe('2026-11-21T13:30:00.000Z')
  })

  it('isBusinessDay is Monday to Saturday', () => {
    expect(isBusinessDay('2026-11-21')).toBe(true)
    expect(isBusinessDay('2026-11-22')).toBe(false)
    expect(isBusinessDay('2026-11-23')).toBe(true)
  })

  it('throws only when the message time is invalid', () => {
    expect(() => resolveDue('2026-11-19', null, 'garbage')).toThrow(RangeError)
  })
})
