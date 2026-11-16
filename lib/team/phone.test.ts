import { describe, expect, it } from 'vitest'
import { effectiveDirection, normalizePhone, parseTeamNumbers } from './phone'

describe('normalizePhone', () => {
  it('keeps the last 10 digits', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210')
    expect(normalizePhone('919876543210@c.us')).toBe('9876543210')
    expect(normalizePhone('09876543210')).toBe('9876543210')
    expect(normalizePhone('9876543210')).toBe('9876543210')
  })
  it('returns null for empty or short input', () => {
    expect(normalizePhone(null)).toBeNull()
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone('12345')).toBeNull()
    expect(normalizePhone('abc')).toBeNull()
  })
})

describe('parseTeamNumbers', () => {
  it('merges vas numbers and the comma separated setting', () => {
    const set = parseTeamNumbers(['+919000000001', null, '9000000002'], '919000000003, 9000000004 ,\n+91 90000 00005;;')
    expect([...set].sort()).toEqual(['9000000001', '9000000002', '9000000003', '9000000004', '9000000005'])
  })
  it('handles a missing setting and dedupes', () => {
    const set = parseTeamNumbers(['9000000001', '+91 9000000001'], null)
    expect([...set]).toEqual(['9000000001'])
  })
  it('ignores junk entries', () => {
    expect(parseTeamNumbers([], 'abc, 123,').size).toBe(0)
  })
})

describe('effectiveDirection', () => {
  const team = new Set(['9000000001'])
  it('marks a team sender as outgoing even when stored as incoming', () => {
    expect(effectiveDirection({ sender_phone: '919000000001', direction: 'incoming' }, team)).toBe('outgoing')
  })
  it('keeps a stored outgoing as outgoing', () => {
    expect(effectiveDirection({ sender_phone: null, direction: 'outgoing' }, team)).toBe('outgoing')
    expect(effectiveDirection({ sender_phone: '918888888888', direction: 'OUTGOING ' }, team)).toBe('outgoing')
  })
  it('treats client senders and null direction as incoming', () => {
    expect(effectiveDirection({ sender_phone: '918888888888', direction: 'incoming' }, team)).toBe('incoming')
    expect(effectiveDirection({ sender_phone: '918888888888', direction: null }, team)).toBe('incoming')
    expect(effectiveDirection({ sender_phone: null, direction: null }, team)).toBe('incoming')
  })
})
