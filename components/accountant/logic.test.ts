import { describe, expect, it } from 'vitest'
import type { ClientListItem, ConversationItem } from '@/lib/data/types'
import {
  buildFilesGrid,
  canEditTickets,
  ticketReadOnlyNote,
  safeHref,
  categoriseDocument,
  computeHomeKpis,
  filterTickets,
  formatAgo,
  formatDateTime,
  formatDelta,
  formatMinutes,
  groupClientsByBucket,
  healthTone,
  monthKey,
  NO_BUCKET_LABEL,
  sortTicketsBySlaLag,
  sparklinePoints,
  ticketWaitMinutes,
} from './logic'

function client(p: Partial<ClientListItem> & { id: string }): ClientListItem {
  return {
    name: p.id,
    legalName: null,
    status: null,
    dealStage: null,
    vaId: 'va1',
    vaName: 'Asha',
    whatsappGroupName: null,
    councilEnabled: false,
    parentClientId: null,
    serviceScore: null,
    moodScore: null,
    serviceDelta: null,
    moodDelta: null,
    scoreComputedAt: null,
    lastMessageAt: null,
    unansweredCount: null,
    worstLagMinutes: null,
    openTickets: 0,
    openEscalations: 0,
    ...p,
  }
}

function ticket(p: Partial<ConversationItem> & { id: string }): ConversationItem {
  return {
    clientId: 'c1',
    clientName: 'Acme',
    vaId: 'va1',
    title: null,
    summary: '',
    status: 'open',
    tag: 'neutral',
    fault: null,
    clientTone: null,
    vaTone: null,
    slaBreached: false,
    openedAt: '2026-11-01T00:00:00Z',
    openedBy: 'council',
    closedAt: null,
    lastMessageAt: '2026-11-16T00:00:00Z',
    lastMessageDirection: 'outgoing',
    messageCount: 1,
    ...p,
  }
}

const NOW = new Date('2026-11-16T06:00:00Z')

describe('computeHomeKpis', () => {
  it('counts clients, open and breached tickets, average health and unanswered', () => {
    const k = computeHomeKpis(
      [
        client({ id: 'a', serviceScore: 80, unansweredCount: 1 }),
        client({ id: 'b', serviceScore: 61, unansweredCount: 0 }),
        client({ id: 'c' }),
      ],
      [ticket({ id: 't1', slaBreached: true }), ticket({ id: 't2' }), ticket({ id: 't3', status: 'closed', slaBreached: true })],
    )
    expect(k).toEqual({ myClients: 3, openTickets: 2, slaBreached: 1, avgHealth: 71, unanswered: 1 })
  })

  it('returns null average health when nobody is scored', () => {
    expect(computeHomeKpis([client({ id: 'a' })], []).avgHealth).toBeNull()
  })
})

describe('groupClientsByBucket', () => {
  it('puts clients without a bucket in "Bucket not set", last, and drops empty groups', () => {
    const groups = groupClientsByBucket(
      [client({ id: 'a' }), client({ id: 'b' }), client({ id: 'c' })],
      new Map([
        ['a', 'DC'],
        ['b', null],
        ['c', 'UNKNOWN'],
      ]),
    )
    expect(groups.map((g) => [g.label, g.clients.map((c) => c.id)])).toEqual([
      ['DC', ['a']],
      [NO_BUCKET_LABEL, ['b', 'c']],
    ])
  })
})

describe('tickets', () => {
  it('measures wait only for open tickets whose last message is from the client', () => {
    expect(ticketWaitMinutes(ticket({ id: 'x', lastMessageDirection: 'incoming', lastMessageAt: '2026-11-16T05:00:00Z' }), NOW)).toBe(60)
    expect(ticketWaitMinutes(ticket({ id: 'y', lastMessageDirection: 'outgoing' }), NOW)).toBeNull()
    expect(ticketWaitMinutes(ticket({ id: 'z', status: 'closed', lastMessageDirection: 'incoming' }), NOW)).toBeNull()
  })

  it('sorts breached first, then longest wait, then oldest activity', () => {
    const sorted = sortTicketsBySlaLag(
      [
        ticket({ id: 'replied-old', lastMessageAt: '2026-11-10T00:00:00Z' }),
        ticket({ id: 'wait-short', lastMessageDirection: 'incoming', lastMessageAt: '2026-11-16T05:30:00Z' }),
        ticket({ id: 'breached', slaBreached: true }),
        ticket({ id: 'wait-long', lastMessageDirection: 'incoming', lastMessageAt: '2026-11-15T05:00:00Z' }),
        ticket({ id: 'replied-new', lastMessageAt: '2026-11-15T00:00:00Z' }),
      ],
      NOW,
    )
    expect(sorted.map((t) => t.id)).toEqual(['breached', 'wait-long', 'wait-short', 'replied-old', 'replied-new'])
  })

  it('filters by title, summary or client name, case-insensitive', () => {
    const list = [
      ticket({ id: '1', title: 'GST filing delay' }),
      ticket({ id: '2', summary: 'Bank statement missing' }),
      ticket({ id: '3', clientName: 'Zeta Foods' }),
    ]
    expect(filterTickets(list, 'gst').map((t) => t.id)).toEqual(['1'])
    expect(filterTickets(list, ' BANK ').map((t) => t.id)).toEqual(['2'])
    expect(filterTickets(list, 'zeta').map((t) => t.id)).toEqual(['3'])
    expect(filterTickets(list, '')).toHaveLength(3)
  })
})

describe('files received', () => {
  it('categorises by folder and file name', () => {
    expect(categoriseDocument({ folderName: 'Client Files/Acme/2026-11-01/Bank', fileName: 'hdfc.pdf' })).toBe('Bank')
    expect(categoriseDocument({ folderName: 'x', fileName: 'Purchase_Invoice_12.pdf' })).toBe('AP')
    expect(categoriseDocument({ folderName: 'x/Sales', fileName: 'jan.xlsx' })).toBe('AR')
    expect(categoriseDocument({ folderName: 'x', fileName: 'INV-SalesInvoice.pdf' })).toBe('Other')
    expect(categoriseDocument({ folderName: 'x', fileName: 'Sales-Invoice-3.pdf' })).toBe('AR')
    expect(categoriseDocument({ folderName: 'x', fileName: 'photo.jpg' })).toBe('Other')
    expect(categoriseDocument({ folderName: 'x', fileName: null })).toBe('Other')
  })

  it('uses the IST month', () => {
    expect(monthKey(new Date('2026-10-31T20:00:00Z'))).toBe('2026-11')
  })

  it('builds a monthly grid ending this month, counting older files separately', () => {
    const grid = buildFilesGrid(
      [
        { folderName: 'Bank', fileName: 'a.pdf', uploadedAt: '2026-11-02T00:00:00Z' },
        { folderName: 'Bank', fileName: 'b.pdf', uploadedAt: '2026-11-03T00:00:00Z' },
        { folderName: 'Sales', fileName: 'c.pdf', uploadedAt: '2026-09-10T00:00:00Z' },
        { folderName: 'misc', fileName: 'd.pdf', uploadedAt: '2025-01-01T00:00:00Z' },
        { folderName: 'misc', fileName: 'e.pdf', uploadedAt: null },
      ],
      NOW,
      3,
    )
    expect(grid.months.map((m) => m.label)).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026'])
    expect(grid.rows.find((r) => r.category === 'Bank')?.counts).toEqual([0, 0, 2])
    expect(grid.rows.find((r) => r.category === 'AR')?.counts).toEqual([1, 0, 0])
    expect(grid.older).toBe(1)
  })

  it('crosses the year boundary', () => {
    const grid = buildFilesGrid([], new Date('2026-01-15T00:00:00Z'), 3)
    expect(grid.months.map((m) => m.key)).toEqual(['2025-11', '2025-12', '2026-01'])
  })
})

describe('health and formatting', () => {
  it('maps scores to tones', () => {
    expect([healthTone(90), healthTone(75), healthTone(60), healthTone(10), healthTone(null)]).toEqual([
      'good',
      'good',
      'watch',
      'risk',
      'none',
    ])
  })

  it('draws sparkline points on a 0..100 scale', () => {
    expect(sparklinePoints([100, 0, 50], 100, 20)).toBe('0,0 50,20 100,10')
    expect(sparklinePoints([50], 100, 20)).toBe('50,10')
    expect(sparklinePoints([], 100, 20)).toBe('')
    expect(sparklinePoints([150], 100, 20)).toBe('50,0')
  })

  it('formats deltas, minutes, dates and ages', () => {
    expect([formatDelta(3), formatDelta(-2), formatDelta(0), formatDelta(null)]).toEqual(['+3', '-2', '0', ''])
    expect([formatMinutes(45), formatMinutes(200), formatMinutes(60), formatMinutes(3120), formatMinutes(2880)]).toEqual([
      '45 min',
      '3 h 20 min',
      '1 h',
      '2 d 4 h',
      '2 d',
    ])
    expect(formatDateTime('2026-11-16T09:00:00Z')).toMatch(/16 Nov 2026, 2:30\s?pm/i)
    expect(formatDateTime(null)).toBe('')
    expect(formatAgo('2026-11-16T05:58:00Z', NOW)).toBe('2 min ago')
    expect(formatAgo('2026-11-16T03:00:00Z', NOW)).toBe('3 h ago')
    expect(formatAgo('2026-11-13T06:00:00Z', NOW)).toBe('3 d ago')
  })
})

describe('ticketReadOnlyNote', () => {
  it('is null for users who can change tickets', () => {
    expect(ticketReadOnlyNote({ role: 'senior_accountant' })).toBeNull()
    expect(ticketReadOnlyNote({ role: 'admin' })).toBeNull()
  })
  it('names the reason: engineer role vs viewing as', () => {
    expect(ticketReadOnlyNote({ role: 'engineer' })).toBe('Read only. Engineers can view tickets but not change them.')
    expect(ticketReadOnlyNote({ role: 'engineer', viewingAs: { vaId: 'v', name: 'n' } })).toBe(
      'Read only while viewing as another accountant.',
    )
  })
})

describe('canEditTickets', () => {
  it('allows accountants and admins, not engineers or view as', () => {
    expect(canEditTickets({ role: 'senior_accountant' })).toBe(true)
    expect(canEditTickets({ role: 'admin' })).toBe(true)
    expect(canEditTickets({ role: 'engineer' })).toBe(false)
    expect(canEditTickets({ role: 'senior_accountant', viewingAs: { vaId: 'v', name: 'n' } })).toBe(false)
  })
})

describe('safeHref', () => {
  it('keeps http(s) links and drops everything else', () => {
    expect(safeHref('https://teams.microsoft.com/l/meetup-join/x')).toBe('https://teams.microsoft.com/l/meetup-join/x')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('not a url')).toBeNull()
    expect(safeHref(null)).toBeNull()
  })
})
