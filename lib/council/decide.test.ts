import { describe, expect, it } from 'vitest'
import { combineVotes, validateVote } from './decide'
import type { Vote } from './types'

function v(decision: Vote['decision'], target: string | null = null, extra: Partial<Vote> = {}): Vote {
  return {
    decision,
    target_conversation_id: target,
    title: 'GST return pending',
    summary: 'Client asked about GST return.',
    tag: 'neutral',
    fault: 'neither',
    client_tone: 'neutral',
    va_tone: 'calm',
    reasoning: 'test',
    ...extra,
  }
}

const ctx = {
  open: [{ id: 'open-1', title: 'TDS', summary: '', last_message_at: '2026-11-01T10:00:00Z' }],
  recentlyClosed: [{ id: 'closed-1', title: 'Invoice', summary: '', last_message_at: '2026-11-01T10:00:00Z', closed_at: '2026-11-10T10:00:00Z' }],
}

describe('validateVote', () => {
  it('keeps a continue or close on an open ticket', () => {
    expect(validateVote(v('continue', 'open-1'), ctx).decision).toBe('continue')
    expect(validateVote(v('close', ' open-1 '), ctx).target_conversation_id).toBe('open-1')
  })

  it('keeps a reopen on a recently closed ticket', () => {
    expect(validateVote(v('reopen', 'closed-1'), ctx)).toMatchObject({ decision: 'reopen', target_conversation_id: 'closed-1' })
  })

  it('turns an invented or missing target into no_action', () => {
    expect(validateVote(v('continue', 'made-up'), ctx)).toMatchObject({ decision: 'no_action', target_conversation_id: null })
    expect(validateVote(v('close', null), ctx).decision).toBe('no_action')
  })

  it('rejects targets with the wrong status', () => {
    expect(validateVote(v('continue', 'closed-1'), ctx).decision).toBe('no_action')
    expect(validateVote(v('reopen', 'open-1'), ctx).decision).toBe('no_action')
  })

  it('forces a null target on new and no_action', () => {
    expect(validateVote(v('new', 'open-1'), ctx).target_conversation_id).toBeNull()
    expect(validateVote(v('no_action', 'open-1'), ctx).target_conversation_id).toBeNull()
  })
})

describe('combineVotes', () => {
  it('takes the decision when both agree', () => {
    expect(combineVotes(v('new'), v('new'))).toMatchObject({ decision: 'new', agreed: true, source: 'A', targetConversationId: null })
    expect(combineVotes(v('continue', 'x'), v('continue', 'x'))).toMatchObject({ decision: 'continue', targetConversationId: 'x', agreed: true })
    expect(combineVotes(v('no_action'), v('no_action'))).toMatchObject({ decision: 'no_action', agreed: true, source: null })
  })

  it('new vs continue becomes continue on the continue voter target', () => {
    expect(combineVotes(v('new'), v('continue', 'b-target'))).toMatchObject({
      decision: 'continue',
      targetConversationId: 'b-target',
      agreed: false,
      source: 'B',
    })
    expect(combineVotes(v('continue', 'a-target'), v('new'))).toMatchObject({
      decision: 'continue',
      targetConversationId: 'a-target',
      agreed: false,
      source: 'A',
    })
  })

  it('closes or reopens only when both agree on the same ticket', () => {
    expect(combineVotes(v('close', 'x'), v('close', 'x'))).toMatchObject({ decision: 'close', agreed: true })
    expect(combineVotes(v('close', 'x'), v('continue', 'y'))).toMatchObject({ decision: 'no_action', agreed: false })
    expect(combineVotes(v('reopen', 'x'), v('no_action'))).toMatchObject({ decision: 'no_action', agreed: false })
    expect(combineVotes(v('reopen', 'x'), v('new'))).toMatchObject({ decision: 'no_action', agreed: false })
  })

  it('close vs continue on the same ticket adds the message to it without closing (KRRD 20 Nov: "GSTR3B filed")', () => {
    expect(combineVotes(v('continue', 'x'), v('close', 'x'))).toMatchObject({ decision: 'continue', targetConversationId: 'x', agreed: false, source: 'A' })
    expect(combineVotes(v('close', 'x'), v('continue', 'x'))).toMatchObject({ decision: 'continue', targetConversationId: 'x', agreed: false, source: 'B' })
  })

  it('same decision on different tickets is no_action', () => {
    expect(combineVotes(v('continue', 'x'), v('continue', 'y'))).toMatchObject({ decision: 'no_action', agreed: false })
    expect(combineVotes(v('close', 'x'), v('close', 'y'))).toMatchObject({ decision: 'no_action', agreed: false })
  })

  it('anything else is no_action', () => {
    expect(combineVotes(v('new'), v('no_action'))).toMatchObject({ decision: 'no_action', agreed: false })
    expect(combineVotes(v('continue', 'x'), v('no_action'))).toMatchObject({ decision: 'no_action', agreed: false })
  })
})
