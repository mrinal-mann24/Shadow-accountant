import { describe, expect, it } from 'vitest'
import { isTag, parseTicketIntent } from './ticket-intent'

function form(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

describe('parseTicketIntent', () => {
  it('accepts close and reopen', () => {
    expect(parseTicketIntent(form({ id: 't1', intent: 'close' }))).toEqual({ ok: true, id: 't1', intent: 'close' })
    expect(parseTicketIntent(form({ id: ' t1 ', intent: 'reopen' }))).toEqual({ ok: true, id: 't1', intent: 'reopen' })
  })

  it('accepts a known tag only', () => {
    expect(parseTicketIntent(form({ id: 't1', intent: 'tag', tag: 'complaint' }))).toEqual({
      ok: true,
      id: 't1',
      intent: 'tag',
      tag: 'complaint',
    })
    expect(parseTicketIntent(form({ id: 't1', intent: 'tag', tag: 'urgent' }))).toEqual({
      ok: false,
      message: 'Please choose a valid tag.',
    })
  })

  it('rejects a missing id or unknown intent', () => {
    expect(parseTicketIntent(form({ intent: 'close' })).ok).toBe(false)
    expect(parseTicketIntent(form({ id: 't1', intent: 'delete' }))).toEqual({ ok: false, message: 'Unknown action.' })
  })

  it('isTag', () => {
    expect(isTag('escalation')).toBe(true)
    expect(isTag('Escalation')).toBe(false)
    expect(isTag(null)).toBe(false)
  })
})
