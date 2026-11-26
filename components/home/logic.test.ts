import { describe, expect, it } from 'vitest'
import { countOverdue, greeting, homeNudge, istDateLine } from './logic'

describe('istDateLine', () => {
  it('formats the IST date, even when UTC is still the previous day', () => {
    expect(istDateLine(new Date('2026-11-26T09:00:00Z'))).toBe('Thursday, 26 November')
    expect(istDateLine(new Date('2026-11-25T20:00:00Z'))).toBe('Thursday, 26 November')
  })
})

describe('greeting', () => {
  it('follows the IST hour', () => {
    expect(greeting(new Date('2026-11-26T03:00:00Z'))).toBe('Good morning') // 8:30 am
    expect(greeting(new Date('2026-11-26T06:30:00Z'))).toBe('Good afternoon') // 12:00 pm
    expect(greeting(new Date('2026-11-26T11:29:00Z'))).toBe('Good afternoon') // 4:59 pm
    expect(greeting(new Date('2026-11-26T11:30:00Z'))).toBe('Good evening') // 5:00 pm
  })
})

describe('homeNudge', () => {
  const base = { waitingClients: 0, firstWaitingClient: null, slaBreached: 0, followUpsDue: 0, openTickets: 0 }
  it('leads with waiting clients and names the first one', () => {
    expect(homeNudge({ ...base, waitingClients: 3, firstWaitingClient: 'Nyvu', slaBreached: 2 })).toBe(
      '3 clients are waiting on your team. Start with Nyvu.',
    )
    expect(homeNudge({ ...base, waitingClients: 1 })).toBe('1 client is waiting on your team.')
  })
  it('falls back to SLA, follow-ups, open tickets, then nothing', () => {
    expect(homeNudge({ ...base, slaBreached: 1, followUpsDue: 4 })).toBe('1 open ticket is past SLA.')
    expect(homeNudge({ ...base, followUpsDue: 2, openTickets: 5 })).toBe('2 follow-ups are due.')
    expect(homeNudge({ ...base, followUpsDue: null, openTickets: 1 })).toBe('No client is waiting. 1 open ticket to work through.')
    expect(homeNudge(base)).toBe('Nothing is waiting on you right now.')
  })
})

describe('countOverdue', () => {
  it('counts missed items and past due times only', () => {
    const now = new Date('2026-11-26T10:00:00Z')
    expect(
      countOverdue(
        [
          { status: 'missed', dueAt: null },
          { status: 'open', dueAt: '2026-11-26T09:00:00Z' },
          { status: 'open', dueAt: '2026-11-26T12:00:00Z' },
          { status: 'open', dueAt: null },
          { status: 'open', dueAt: 'bad' },
        ],
        now,
      ),
    ).toBe(2)
  })
})
