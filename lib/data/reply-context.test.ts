import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'
import { clearTeamNumbersCache } from '@/lib/team'
import { createFakeSupabase, type FakeTables } from './testing/fake-supabase'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import { getReplyContext, REPLY_CONTEXT_LIMITS } from './reply-context'

const NOW = new Date('2026-11-17T06:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

function conv(id: string, client: string, o: Record<string, unknown> = {}) {
  return {
    id, client_id: client, va_id: 'va1', title: `Ticket ${id}`, summary: 's', status: 'open', tag: 'neutral', fault: null,
    client_tone: null, va_tone: null, sla_breached: false, opened_at: daysAgo(10), opened_by: 'council', closed_at: null,
    last_message_at: daysAgo(1), last_message_direction: 'incoming', message_count: 1, updated_at: daysAgo(1), ...o,
  }
}
function msg(id: string, client: string, at: string, o: Record<string, unknown> = {}) {
  return {
    message_id: id, dedup_hash: `wa-${id}`, client_id: client, message_timestamp: at, body: `body ${id}`, sender_name: null,
    sender_phone: '918888888888', direction: 'incoming', message_type: 'chat', conversation_id: null, ...o,
  }
}

function fixtures(): FakeTables {
  const many = Array.from({ length: 40 }, (_, i) => msg(`r${i}`, 'c1', daysAgo(40 - i)))
  return {
    vas: [{ va_id: 'va1', va_name: 'Asha', email: 'a@example.com', status: 'active', whatsapp_number: '919000000001' }],
    settings: [{ key: 'team_whatsapp_numbers', value: '919000000009', note: null }],
    clients: [
      { client_id: 'c1', client_name: 'Alpha Traders', va_id: 'va1' },
      { client_id: 'c2', client_name: 'Beta Foods', va_id: 'va2' },
    ],
    conversations: [
      conv('t1', 'c1', { status: 'closed', closed_at: daysAgo(3), title: 'GST return October' }),
      conv('t2', 'c1', { last_message_at: daysAgo(2) }),
      conv('t3', 'c1', { last_message_at: daysAgo(45) }),
      conv('t9', 'c2'),
    ],
    client_messages: [
      ...many,
      msg('m1', 'c1', daysAgo(5), { conversation_id: 't1', body: 'Please file GST' }),
      msg('m2', 'c1', daysAgo(3), { conversation_id: 't1', body: 'Filed, ARN AA2910260012345', sender_phone: '919000000009' }),
      msg('x1', 'c2', daysAgo(1), { conversation_id: 't9', body: 'Beta secret' }),
    ],
    document_uploads: [
      { upload_id: 'd1', client_id: 'c1', file_name: 'gstr3b.pdf', folder_name: 'Alpha', file_type: 'pdf', file_size: 1, uploaded_at: daysAgo(3), group_name: null },
      { upload_id: 'd2', client_id: 'c1', file_name: 'old.pdf', folder_name: 'Alpha', file_type: 'pdf', file_size: 1, uploaded_at: daysAgo(60), group_name: null },
      { upload_id: 'd3', client_id: 'c2', file_name: 'beta.pdf', folder_name: 'Beta', file_type: 'pdf', file_size: 1, uploaded_at: daysAgo(1), group_name: null },
    ],
  }
}

const acc1: AppUser = { id: 'u1', email: 'a@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const admin: AppUser = { id: 'u2', email: 'admin@example.com', name: 'Admin', role: 'admin', vaId: null }

beforeEach(() => {
  state.db = createFakeSupabase(fixtures()).client
  clearTeamNumbersCache()
})

describe('getReplyContext', () => {
  it('returns the ticket, its messages, recent messages, other tickets and files', async () => {
    const ctx = await getReplyContext(acc1, 't1', NOW)
    expect(ctx).not.toBeNull()
    expect(ctx!.ticket.id).toBe('t1')
    expect(ctx!.clientName).toBe('Alpha Traders')
    expect(ctx!.ticketMessages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(ctx!.ticketMessages[1].fromTeam).toBe(true)
    expect(ctx!.ticketMessages[0].fromTeam).toBe(false)
    expect(ctx!.otherTickets.map((t) => t.id)).toEqual(['t2'])
    expect(ctx!.files.map((f) => f.id)).toEqual(['d1'])
  })

  it('caps recent messages and returns them oldest first', async () => {
    const ctx = await getReplyContext(acc1, 't1', NOW)
    const recent = ctx!.recentMessages
    expect(recent).toHaveLength(REPLY_CONTEXT_LIMITS.recentMessages)
    const times = recent.map((m) => m.at)
    expect([...times].sort()).toEqual(times)
  })

  it("never returns another client's data", async () => {
    const ctx = await getReplyContext(admin, 't1', NOW)
    const ids = [...ctx!.ticketMessages, ...ctx!.recentMessages].map((m) => m.id)
    expect(ids).not.toContain('x1')
    expect(ctx!.files.map((f) => f.id)).not.toContain('d3')
  })

  it("forbids an accountant from another accountant's ticket", async () => {
    await expect(getReplyContext(acc1, 't9', NOW)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('admin can read any ticket', async () => {
    const ctx = await getReplyContext(admin, 't9', NOW)
    expect(ctx!.ticketMessages.map((m) => m.id)).toEqual(['x1'])
  })

  it('returns null for an unknown ticket', async () => {
    expect(await getReplyContext(acc1, 'nope', NOW)).toBeNull()
  })
})
