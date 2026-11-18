import { describe, expect, it } from 'vitest'
import type { FollowUpView } from '@/lib/followups/types'
import {
  actReadOnlyNote,
  canAct,
  closedLabel,
  dueLabel,
  dueTone,
  followUpDueLabel,
  followUpDueTone,
  groupFollowUps,
  isActive,
  isFromHistory,
  kindLabel,
} from './follow-ups'

// 18 Nov 2026, 11:30 am IST
const NOW = new Date('2026-11-18T06:00:00Z')

function fu(p: Partial<FollowUpView>): FollowUpView {
  return {
    id: 'id',
    clientId: 'c1',
    clientName: 'Client',
    kind: 'promise',
    item: 'Share MIS',
    status: 'open',
    dueAt: null,
    createdAt: '2026-11-10T00:00:00Z',
    sourceAt: '2026-11-10T00:00:00Z',
    sourceSender: null,
    vaId: null,
    vaName: null,
    conversationId: null,
    reminderCount: 0,
    resolvedAt: null,
    resolvedBy: null,
    ...p,
  }
}

describe('dueLabel', () => {
  it('counts overdue days by IST calendar day', () => {
    expect(dueLabel('2026-11-16T06:00:00Z', NOW)).toBe('Overdue 2 days')
    expect(dueLabel('2026-11-17T18:29:00Z', NOW)).toBe('Overdue 1 day') // 17 Nov 11:59 pm IST
  })

  it('says Overdue for earlier today and Due today for later today (IST)', () => {
    expect(dueLabel('2026-11-17T20:00:00Z', NOW)).toBe('Overdue') // 18 Nov 1:30 am IST
    expect(dueLabel('2026-11-18T12:00:00Z', NOW)).toBe('Due today') // 18 Nov 5:30 pm IST
  })

  it('shows the IST date for later days, with the year only when it differs', () => {
    expect(dueLabel('2026-11-18T19:00:00Z', NOW)).toBe('Due 19 Nov') // still 18 Nov in UTC
    expect(dueLabel('2026-11-21T05:00:00Z', NOW)).toBe('Due 21 Nov')
    expect(dueLabel('2027-01-03T05:00:00Z', NOW)).toBe('Due 3 Jan 2027')
  })

  it('handles missing or bad dates', () => {
    expect(dueLabel(null, NOW)).toBe('No due date')
    expect(dueLabel(undefined, NOW)).toBe('No due date')
    expect(dueLabel('not a date', NOW)).toBe('No due date')
  })

  it('maps to a tone', () => {
    expect(dueTone('2026-11-16T06:00:00Z', NOW)).toBe('overdue')
    expect(dueTone('2026-11-18T12:00:00Z', NOW)).toBe('today')
    expect(dueTone('2026-11-21T05:00:00Z', NOW)).toBe('later')
    expect(dueTone(null, NOW)).toBe('none')
  })
})

describe('followUpDueLabel', () => {
  it('says Missed with the IST due date for a missed item, so it stands apart from Overdue', () => {
    expect(followUpDueLabel({ status: 'missed', dueAt: '2026-11-16T13:30:00Z' }, NOW)).toBe('Missed (due 16 Nov)')
    expect(followUpDueLabel({ status: 'missed', dueAt: '2026-11-17T18:45:00Z' }, NOW)).toBe('Missed (due 18 Nov)') // 12:15 am IST
    expect(followUpDueLabel({ status: 'missed', dueAt: '2025-12-30T13:30:00Z' }, NOW)).toBe('Missed (due 30 Dec 2025)')
    expect(followUpDueLabel({ status: 'missed', dueAt: null }, NOW)).toBe('Missed')
    expect(followUpDueLabel({ status: 'missed', dueAt: 'bad' }, NOW)).toBe('Missed')
  })

  it('uses dueLabel for open items', () => {
    expect(followUpDueLabel({ status: 'open', dueAt: '2026-11-16T06:00:00Z' }, NOW)).toBe('Overdue 2 days')
    expect(followUpDueLabel({ status: 'open', dueAt: '2026-11-18T12:00:00Z' }, NOW)).toBe('Due today')
    expect(followUpDueLabel({ status: 'open', dueAt: null }, NOW)).toBe('No due date')
  })

  it('keeps a missed item in the overdue tone', () => {
    expect(followUpDueTone({ status: 'missed', dueAt: '2026-11-16T13:30:00Z' }, NOW)).toBe('overdue')
    expect(followUpDueTone({ status: 'missed', dueAt: null }, NOW)).toBe('overdue')
    expect(followUpDueTone({ status: 'open', dueAt: '2026-11-21T05:00:00Z' }, NOW)).toBe('later')
  })
})

describe('isFromHistory', () => {
  it('marks items created more than 24 h after their source message', () => {
    expect(isFromHistory({ sourceAt: '2026-10-20T06:00:00Z', createdAt: '2026-11-17T06:00:00Z' })).toBe(true)
    expect(isFromHistory({ sourceAt: '2026-11-16T06:00:00Z', createdAt: '2026-11-17T06:00:00.001Z' })).toBe(true)
    expect(isFromHistory({ sourceAt: '2026-11-16T06:00:00Z', createdAt: '2026-11-17T06:00:00Z' })).toBe(false)
    expect(isFromHistory({ sourceAt: '2026-11-17T06:00:00Z', createdAt: '2026-11-17T06:15:00Z' })).toBe(false)
    expect(isFromHistory({ sourceAt: 'bad', createdAt: '2026-11-17T06:00:00Z' })).toBe(false)
  })
})

describe('kindLabel', () => {
  it('labels each kind and passes unknown ones through', () => {
    expect(kindLabel('promise')).toBe('Promise')
    expect(kindLabel('document')).toBe('Document')
    expect(kindLabel('repeat_ask')).toBe('Asked again')
    expect(kindLabel('other')).toBe('other')
  })
})

describe('canAct', () => {
  it('lets senior accountants and admins act, not engineers or view as', () => {
    expect(canAct({ role: 'senior_accountant' })).toBe(true)
    expect(canAct({ role: 'admin' })).toBe(true)
    expect(canAct({ role: 'engineer' })).toBe(false)
    expect(canAct({ role: 'senior_accountant', viewingAs: { vaId: 'v', name: 'A' } })).toBe(false)
    expect(canAct({ role: 'senior_accountant', viewingAs: true })).toBe(false)
    expect(canAct({ role: 'admin', viewingAs: false })).toBe(true)
  })

  it('explains why it is read only', () => {
    expect(actReadOnlyNote({ role: 'admin' })).toBeNull()
    expect(actReadOnlyNote({ role: 'engineer' })).toMatch(/Engineers/)
    expect(actReadOnlyNote({ role: 'senior_accountant', viewingAs: true })).toMatch(/viewing as/)
  })
})

describe('groupFollowUps', () => {
  it('splits open items by kind, most urgent first, and keeps missed ones open', () => {
    const g = groupFollowUps([
      fu({ id: 'p2', dueAt: '2026-11-20T00:00:00Z' }),
      fu({ id: 'p1', dueAt: '2026-11-15T00:00:00Z', status: 'missed' }),
      fu({ id: 'p3', dueAt: null }),
      fu({ id: 'd2', kind: 'document', sourceAt: '2026-11-12T00:00:00Z' }),
      fu({ id: 'd1', kind: 'document', sourceAt: '2026-11-11T00:00:00Z' }),
      fu({ id: 'r1', kind: 'repeat_ask' }),
      fu({ id: 'x', status: 'done', resolvedAt: '2026-11-17T00:00:00Z' }),
    ])
    expect(g.promises.map((f) => f.id)).toEqual(['p1', 'p2', 'p3'])
    expect(g.documents.map((f) => f.id)).toEqual(['d1', 'd2'])
    expect(g.repeatAsks.map((f) => f.id)).toEqual(['r1'])
    expect(g.closed.map((f) => f.id)).toEqual(['x'])
  })

  it('keeps only the latest closed ones', () => {
    const closed = Array.from({ length: 12 }, (_, i) =>
      fu({ id: `c${i}`, status: i % 2 ? 'done' : 'cancelled', resolvedAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z` }),
    )
    const g = groupFollowUps(closed)
    expect(g.closed).toHaveLength(10)
    expect(g.closed[0].id).toBe('c11')
    expect(g.closed[9].id).toBe('c2')
  })

  it('treats open and missed as active', () => {
    expect(isActive({ status: 'open' })).toBe(true)
    expect(isActive({ status: 'missed' })).toBe(true)
    expect(isActive({ status: 'done' })).toBe(false)
    expect(isActive({ status: 'cancelled' })).toBe(false)
  })
})

describe('closedLabel', () => {
  it('uses repeat ask wording for repeat asks', () => {
    expect(closedLabel({ kind: 'promise', status: 'done' })).toBe('Done')
    expect(closedLabel({ kind: 'document', status: 'cancelled' })).toBe('Not needed')
    expect(closedLabel({ kind: 'repeat_ask', status: 'done' })).toBe('Answered')
    expect(closedLabel({ kind: 'repeat_ask', status: 'cancelled' })).toBe('Not a repeat')
  })
})
