import { describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'
import type { ReplyContext } from '@/lib/data/reply-context'
import type { ConversationItem, MessageItem } from '@/lib/data/types'
import type { StoredGuide } from './style-guide'
import { messagesBefore, pendingQuestion, suggestReply, type SuggestDeps } from './suggest'

const user: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const guide: StoredGuide = { guide: 'GUIDE', version: 2, model: 'm', builtAt: '2026-11-27T00:00:00Z', messages: 100, corrections: 1 }

function msg(id: string, at: string, direction: 'incoming' | 'outgoing', body: string): MessageItem {
  return {
    id,
    waMessageId: id,
    at,
    body,
    senderName: null,
    direction,
    storedDirection: direction,
    fromTeam: direction === 'outgoing',
    messageType: 'chat',
    conversationId: 't1',
  }
}

function ticket(o: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: 't1',
    clientId: 'c1',
    clientName: 'KRRD',
    vaId: 'va1',
    title: 'CN',
    summary: '',
    status: 'open',
    tag: 'neutral',
    fault: null,
    clientTone: null,
    vaTone: null,
    slaBreached: false,
    openedAt: '2026-11-27T04:00:00Z',
    openedBy: 'incoming',
    closedAt: null,
    lastMessageAt: '2026-11-27T05:00:00Z',
    lastMessageDirection: 'incoming',
    messageCount: 2,
    ...o,
  }
}

const thread = [
  msg('m1', '2026-11-27T04:00:00Z', 'incoming', 'Pls issue a CN for the duplicate invoice'),
  msg('m2', '2026-11-27T04:10:00Z', 'outgoing', 'Noted sir'),
  msg('m3', '2026-11-27T05:00:00Z', 'incoming', 'Any update? OTP is 445566'),
]

function ctx(o: Partial<ReplyContext> = {}): ReplyContext {
  return { ticket: ticket(), clientName: 'KRRD', ticketMessages: thread, recentMessages: thread, otherTickets: [], files: [], ...o }
}

function deps(o: Partial<SuggestDeps> = {}): Partial<SuggestDeps> {
  return {
    getContext: async () => ctx(),
    getStyle: async () => guide,
    getCorrections: async () => [{ draft: 'Will check', finalText: 'Checked sir, CN shared' }],
    generate: vi.fn(async () => 'Noted sir, sharing the CN draft shortly. Call 9876543210'),
    save: vi.fn(async () => 's1'),
    findRecent: async () => null,
    modelId: () => 'anthropic/claude-haiku-5.5',
    ...o,
  }
}

describe('pendingQuestion / messagesBefore', () => {
  it('takes the trailing client messages after our last one', () => {
    expect(pendingQuestion(thread).map((m) => m.id)).toEqual(['m3'])
    expect(pendingQuestion([...thread, msg('m4', '2026-11-27T05:10:00Z', 'outgoing', 'ok')])).toEqual([])
  })
  it('keeps the n messages before the question', () => {
    expect(messagesBefore(thread, '2026-11-27T05:00:00Z', 1).map((m) => m.id)).toEqual(['m2'])
  })
})

describe('suggestReply', () => {
  it('writes a masked draft in the client style, with corrections, and saves it', async () => {
    const d = deps()
    const r = await suggestReply(user, 't1', {}, d)
    expect(r).toMatchObject({ ok: true, suggestionId: 's1', reused: false, guideVersion: 2 })
    if (!r.ok) return
    expect(r.draft).toBe('Noted sir, sharing the CN draft shortly. Call [number]')
    expect(r.text).toBe(r.draft)
    const prompt = (d.generate as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(prompt).toContain('GUIDE')
    expect(prompt).toContain('Sent instead: Checked sir, CN shared')
    expect(prompt).toContain('OTP is [hidden]')
    expect(prompt).not.toContain('445566')
    expect(d.save).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ conversationId: 't1', clientId: 'c1', promptVersion: 'v3', guideVersion: 2 }),
    )
  })

  it('shows the earlier suggestion for the same client message without a model call', async () => {
    const d = deps({ findRecent: async () => ({ id: 's0', draft: 'Old draft', finalText: 'My edit', action: 'edited', guideVersion: 1 }) })
    const r = await suggestReply(user, 't1', {}, d)
    expect(r).toMatchObject({ ok: true, reused: true, draft: 'Old draft', text: 'My edit', suggestionId: 's0', guideVersion: 1 })
    expect(d.generate).not.toHaveBeenCalled()
  })

  it('Regenerate (force) writes a new one even when one exists', async () => {
    const d = deps({ findRecent: async () => ({ id: 's0', draft: 'Old', finalText: null, action: null, guideVersion: 1 }) })
    const r = await suggestReply(user, 't1', { force: true }, d)
    expect(r).toMatchObject({ ok: true, reused: false })
    expect(d.generate).toHaveBeenCalledOnce()
  })

  it('says why there is no suggestion', async () => {
    expect(await suggestReply(user, 't1', {}, deps({ getContext: async () => null }))).toMatchObject({ ok: false, reason: 'not_found' })
    expect(
      await suggestReply(user, 't1', {}, deps({ getContext: async () => ctx({ ticket: ticket({ status: 'closed' }) }) })),
    ).toMatchObject({ ok: false, reason: 'closed' })
    expect(await suggestReply(user, 't1', {}, deps({ getStyle: async () => null }))).toMatchObject({ ok: false, reason: 'not_pilot' })
    const answered = [...thread, msg('m4', '2026-11-27T05:10:00Z', 'outgoing', 'Sharing now')]
    expect(
      await suggestReply(user, 't1', {}, deps({ getContext: async () => ctx({ ticketMessages: answered, recentMessages: answered }) })),
    ).toMatchObject({ ok: false, reason: 'no_question' })
    expect(await suggestReply(user, 't1', {}, deps({ generate: async () => '   ' }))).toMatchObject({ ok: false, reason: 'empty' })
    const forbidden = deps({
      getContext: async () => {
        throw new ForbiddenError()
      },
    })
    expect(await suggestReply(user, 't1', {}, forbidden)).toMatchObject({ ok: false, reason: 'forbidden' })
  })

  it('still shows the reply when saving it fails', async () => {
    const failing = deps({
      save: async () => {
        throw new Error('db down')
      },
    })
    expect(await suggestReply(user, 't1', {}, failing)).toMatchObject({ ok: true, suggestionId: null })
  })
})
