import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => null }))

import { buildTeamOverview } from './admin'
import type { ClientListItem, ConversationItem } from './types'

const client = (id: string, vaId: string) => ({ id, name: id, vaId, serviceScore: null, unansweredCount: 0 }) as unknown as ClientListItem

function ticket(id: string, o: Partial<ConversationItem>): ConversationItem {
  return {
    id,
    clientId: 'c1',
    clientName: 'Alpha',
    vaId: 'va1',
    title: id,
    summary: '',
    status: 'open',
    tag: 'neutral',
    fault: null,
    clientTone: null,
    vaTone: null,
    slaBreached: false,
    openedAt: '2026-11-26T06:00:00Z',
    openedBy: 'incoming',
    closedAt: null,
    lastMessageAt: '2026-11-26T07:00:00Z',
    lastMessageDirection: 'incoming',
    messageCount: 2,
    ...o,
  }
}

describe('buildTeamOverview open tickets', () => {
  it('counts only tickets waiting on us; a ticket waiting on the client is left out', () => {
    const o = buildTeamOverview(
      [{ va_id: 'va1', va_name: 'Asha', status: 'active' }],
      [client('c1', 'va1')],
      [
        ticket('client-asked', { openedBy: 'incoming', lastMessageDirection: 'incoming' }),
        ticket('we-replied', { openedBy: 'incoming', lastMessageDirection: 'outgoing' }),
        ticket('we-asked', { openedBy: 'outgoing', lastMessageDirection: 'outgoing' }),
        ticket('client-answered', { openedBy: 'outgoing', lastMessageDirection: 'incoming' }),
      ],
    )
    expect(o.accountants[0].openTickets).toBe(3)
  })
})
