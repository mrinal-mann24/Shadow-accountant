import { describe, expect, it } from 'vitest'
import { accountantLoad, assignedOpenTickets, initials } from './logic'

describe('initials', () => {
  it('takes first and last word, or the first two letters of one word', () => {
    expect(initials('Ajith Kumar')).toBe('AK')
    expect(initials('  deeksha  m shetty ')).toBe('DS')
    expect(initials('Gayathri')).toBe('GA')
    expect(initials('')).toBe('?')
  })
})

describe('accountantLoad', () => {
  const a = { openTickets: 38, openEscalations: 0, slaBreachedOpen: 0, unansweredClients: 0 }
  it('gives the share of team open tickets', () => {
    expect(accountantLoad(a, 62).share).toBe(61)
    expect(accountantLoad({ ...a, openTickets: 0 }, 0).share).toBe(0)
  })
  it('is risk with escalations or SLA breaches, watch with waiting clients, else calm', () => {
    expect(accountantLoad({ ...a, openEscalations: 1 }, 62).tone).toBe('risk')
    expect(accountantLoad({ ...a, slaBreachedOpen: 2, unansweredClients: 1 }, 62).tone).toBe('risk')
    expect(accountantLoad({ ...a, unansweredClients: 1 }, 62).tone).toBe('watch')
    expect(accountantLoad(a, 62).tone).toBe('calm')
  })
  it('sums open tickets across accountants', () => {
    expect(assignedOpenTickets([{ openTickets: 38 }, { openTickets: 13 }, { openTickets: 0 }])).toBe(51)
  })
})
