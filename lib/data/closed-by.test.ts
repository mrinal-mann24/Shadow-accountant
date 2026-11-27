import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUser } from '@/lib/auth/types'
import { createFakeSupabase, type FakeTables } from './testing/fake-supabase'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import { decideClosedBy } from './conversations'
import { listConversations } from './index'

const admin: AppUser = { id: 'u2', email: 'admin@example.com', name: 'Admin', role: 'admin', vaId: null }

describe('decideClosedBy', () => {
  it('is undefined while the ticket is open', () => {
    expect(decideClosedBy(null, ['2026-11-26T06:42:20Z'])).toBeUndefined()
  })
  it('is ai when closed_at equals the time of a council close message', () => {
    expect(decideClosedBy('2026-11-26T06:42:20+00:00', ['2026-11-25T10:00:00Z', '2026-11-26T06:42:20Z'])).toBe('ai')
  })
  it('is person when no council close matches (a click in Shadow or Teams)', () => {
    expect(decideClosedBy('2026-11-26T12:12:20.497Z', ['2026-11-26T06:42:20Z'])).toBe('person')
    expect(decideClosedBy('2026-11-26T12:12:20.497Z', undefined)).toBe('person')
  })
})

function conv(id: string, status: string, closed_at: string | null) {
  return {
    id,
    client_id: 'c1',
    va_id: 'va1',
    title: id,
    summary: '',
    status,
    tag: 'neutral',
    fault: 'neither',
    client_tone: null,
    va_tone: null,
    sla_breached: false,
    opened_at: '2026-11-24T05:00:00Z',
    opened_by: 'incoming',
    closed_at,
    last_message_at: '2026-11-26T06:00:00Z',
    last_message_direction: 'incoming',
    message_count: 3,
  }
}

function fixtures(): FakeTables {
  return {
    clients: [{ client_id: 'c1', client_name: 'Alpha', va_id: 'va1' }],
    conversations: [
      conv('t-open', 'open', null),
      conv('t-ai', 'closed', '2026-11-26T06:42:20Z'),
      // The council closed it once, it was reopened, then a person closed it later: the person wins.
      conv('t-person', 'closed', '2026-11-26T12:12:20.497Z'),
    ],
    council_verdicts: [
      { message_id: 'm1', final_decision: 'close', final_conv_id: 't-ai' },
      { message_id: 'm2', final_decision: 'close', final_conv_id: 't-person' },
      { message_id: 'm3', final_decision: 'continue', final_conv_id: 't-open' },
    ],
    client_messages: [
      { message_id: 'm1', client_id: 'c1', message_timestamp: '2026-11-26T06:42:20Z' },
      { message_id: 'm2', client_id: 'c1', message_timestamp: '2026-11-25T09:00:00Z' },
      { message_id: 'm3', client_id: 'c1', message_timestamp: '2026-11-26T06:00:00Z' },
    ],
  }
}

beforeEach(() => {
  state.db = createFakeSupabase(fixtures()).client
})

describe('listConversations closedBy', () => {
  it('labels AI and manual closes and leaves open tickets unset', async () => {
    const rows = await listConversations(admin)
    const by = Object.fromEntries(rows.map((r) => [r.id, r.closedBy]))
    expect(by).toEqual({ 't-open': undefined, 't-ai': 'ai', 't-person': 'person' })
  })
})
