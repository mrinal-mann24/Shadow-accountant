import { describe, expect, it } from 'vitest'
import type { ClientListItem, TeamOverview } from '@/lib/data/types'
import { ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'
import { GENERIC_ERROR, toActionError } from './action-result'
import { formatAgo, formatDateTime, formatMinutes, formatScore, isStale, scoreClass } from './format'
import { sortForAssignment, teamKpis } from './kpis'
import { adminSubnav } from './subnav'

const NOW = new Date('2026-11-16T10:00:00.000Z')

function client(over: Partial<ClientListItem> & { id: string; name: string }): ClientListItem {
  return {
    legalName: null,
    status: null,
    dealStage: null,
    vaId: null,
    vaName: null,
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
    ...over,
  }
}

describe('format', () => {
  it('formats date time in IST', () => {
    // 10:00 UTC = 3:30 pm IST
    const s = formatDateTime('2026-11-16T10:00:00.000Z')
    expect(s).toContain('16 Nov 2026')
    expect(s).toMatch(/3:30\s?pm/i)
  })

  it('says Never for missing or invalid dates', () => {
    expect(formatDateTime(null)).toBe('Never')
    expect(formatDateTime('not a date')).toBe('Never')
    expect(formatAgo(undefined, NOW)).toBe('Never')
  })

  it('formats relative ages', () => {
    expect(formatAgo('2026-11-16T09:59:40.000Z', NOW)).toBe('just now')
    expect(formatAgo('2026-11-16T11:00:00.000Z', NOW)).toBe('just now')
    expect(formatAgo('2026-11-16T09:48:00.000Z', NOW)).toBe('12 min ago')
    expect(formatAgo('2026-11-16T07:00:00.000Z', NOW)).toBe('3 h ago')
    expect(formatAgo('2026-11-15T09:00:00.000Z', NOW)).toBe('1 day ago')
    expect(formatAgo('2026-11-12T10:00:00.000Z', NOW)).toBe('4 days ago')
  })

  it('isStale treats missing as stale and compares minutes', () => {
    expect(isStale(null, NOW, 60)).toBe(true)
    expect(isStale('2026-11-16T09:30:00.000Z', NOW, 60)).toBe(false)
    expect(isStale('2026-11-16T08:59:00.000Z', NOW, 60)).toBe(true)
  })

  it('formats minutes, scores and score colours', () => {
    expect(formatMinutes(null)).toBe('None')
    expect(formatMinutes(45.4)).toBe('45 min')
    expect(formatMinutes(330)).toBe('5.5 h')
    expect(formatMinutes(60 * 72)).toBe('3 days')
    expect(formatScore(null)).toBe('Not scored')
    expect(formatScore(71.6)).toBe('72')
    expect(scoreClass(null)).toBe('text-muted-foreground')
    expect(scoreClass(40)).toBe('text-destructive')
    expect(scoreClass(60)).toBe('text-warning')
    expect(scoreClass(85)).toBe('text-foreground')
  })
})

describe('teamKpis', () => {
  const clients = [
    client({ id: 'c1', name: 'Alpha', vaId: 'v1', serviceScore: 80, openTickets: 2, openEscalations: 1, unansweredCount: 1 }),
    client({ id: 'c2', name: 'Beta', vaId: 'v1', serviceScore: 61, openTickets: 1 }),
    client({ id: 'c3', name: 'Gamma', openTickets: 3, unansweredCount: 0 }),
  ]
  const overview: TeamOverview = {
    accountants: [
      { vaId: 'v1', name: 'Asha', status: 'active', clientCount: 2, openTickets: 3, openEscalations: 1, slaBreachedOpen: 2, unansweredClients: 1, avgServiceScore: 70.5 },
      { vaId: 'v2', name: 'Ravi', status: 'active', clientCount: 0, openTickets: 0, openEscalations: 0, slaBreachedOpen: 1, unansweredClients: 0, avgServiceScore: null },
    ],
    unassignedClients: 1,
    escalations: [{ id: 't1' } as TeamOverview['escalations'][number]],
    lowestHealth: [],
    hubspotLastSync: null,
  }

  it('totals across every client, including unassigned ones', () => {
    expect(teamKpis(overview, clients)).toEqual({
      clients: 3,
      unassigned: 1,
      openTickets: 6,
      openEscalations: 1,
      slaBreached: 3,
      unansweredClients: 1,
      scoredClients: 2,
      avgHealth: 70.5,
    })
  })

  it('has a null average when nobody is scored', () => {
    const empty: TeamOverview = { accountants: [], unassignedClients: 0, escalations: [], lowestHealth: [], hubspotLastSync: null }
    expect(teamKpis(empty, []).avgHealth).toBeNull()
    expect(teamKpis(empty, []).clients).toBe(0)
  })
})

describe('sortForAssignment', () => {
  it('puts unassigned first, then sorts by name, without mutating', () => {
    const input = [
      client({ id: '1', name: 'Zed', vaId: 'v1' }),
      client({ id: '2', name: 'Mango' }),
      client({ id: '3', name: 'Apple', vaId: 'v2' }),
      client({ id: '4', name: 'Banana' }),
    ]
    expect(sortForAssignment(input).map((c) => c.name)).toEqual(['Banana', 'Mango', 'Apple', 'Zed'])
    expect(input[0].name).toBe('Zed')
  })
})

describe('adminSubnav', () => {
  it('shows all tabs to admins and only Team to engineers', () => {
    expect(adminSubnav('admin').map((i) => i.href)).toEqual(['/admin', '/admin/assignment', '/admin/users'])
    expect(adminSubnav('engineer').map((i) => i.href)).toEqual(['/admin'])
  })
})

describe('toActionError', () => {
  it('shows ForbiddenError and view-as messages as they are', () => {
    expect(toActionError(new ForbiddenError())).toEqual({ ok: false, error: 'You do not have access to do this.' })
    expect(toActionError(new ViewAsReadOnlyError())).toEqual({ ok: false, error: new ViewAsReadOnlyError().message })
    expect(toActionError(new ForbiddenError('You cannot change your own role.'))).toEqual({
      ok: false,
      error: 'You cannot change your own role.',
    })
  })

  it('shows known not-found messages', () => {
    expect(toActionError(new Error('Client not found.'))).toEqual({ ok: false, error: 'Client not found.' })
  })

  it('hides database errors behind a generic message', () => {
    const spy = console.error
    console.error = () => {}
    try {
      expect(toActionError(new Error('assignClient: relation "clients" does not exist'))).toEqual({ ok: false, error: GENERIC_ERROR })
      expect(toActionError('boom')).toEqual({ ok: false, error: GENERIC_ERROR })
    } finally {
      console.error = spy
    }
  })
})
