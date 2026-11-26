import { describe, expect, it } from 'vitest'
import {
  cleanGroupName,
  displayNameOf,
  groupClients,
  hasHubspotDeal,
  initialsOf,
  parseClientTab,
  subgroupCount,
} from './client-groups'
import type { ClientListItem } from './types'

function client(p: Partial<ClientListItem> & { id: string }): ClientListItem {
  return {
    name: p.id,
    legalName: null,
    status: 'Active',
    dealStage: null,
    vaId: 'va1',
    vaName: 'Asha',
    whatsappGroupName: null,
    councilEnabled: false,
    parentClientId: null,
    hubspotDealId: null,
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

const ids = (gs: { client: { id: string } }[]) => gs.map((g) => g.client.id)

describe('cleanGroupName', () => {
  it('strips the usual team suffixes, any case', () => {
    expect(cleanGroupName('Horizon Marketing <> VA')).toBe('Horizon Marketing')
    expect(cleanGroupName('Wander Cafe<>VA')).toBe('Wander Cafe')
    expect(cleanGroupName('BANDODKAR GROUP <> Virtual Accounting')).toBe('BANDODKAR GROUP')
    expect(cleanGroupName('Leapmile <> Virtual Accounting services')).toBe('Leapmile')
    expect(cleanGroupName('Zam Steel <> AIA')).toBe('Zam Steel')
    expect(cleanGroupName('Ragnayor Foods <> va')).toBe('Ragnayor Foods')
    expect(cleanGroupName('Nirved Medicals -  VA')).toBe('Nirved Medicals')
    expect(cleanGroupName('Nirved Medicals-VA')).toBe('Nirved Medicals')
    expect(cleanGroupName('Packworth group X VA')).toBe('Packworth group')
    expect(cleanGroupName('Pneuma Club (Umang) x Virtual Accounting')).toBe('Pneuma Club (Umang)')
    expect(cleanGroupName('Leapmile-Korefi - Virtual Accounting Team')).toBe('Leapmile-Korefi')
    expect(cleanGroupName('Alpha x AIA')).toBe('Alpha')
  })
  it('keeps names without a team suffix', () => {
    expect(cleanGroupName('Horizon - kamalpur')).toBe('Horizon - kamalpur')
    expect(cleanGroupName('IndoFolk Wellness <> Annual Filing')).toBe('IndoFolk Wellness <> Annual Filing')
    expect(cleanGroupName('NYVY-VXI PAYMENT')).toBe('NYVY-VXI PAYMENT')
    expect(cleanGroupName('Max VA')).toBe('Max VA')
    expect(cleanGroupName('Box AIA')).toBe('Box AIA')
    expect(cleanGroupName(null)).toBe('')
  })
})

describe('displayNameOf', () => {
  it('leads with the business name from the group, else falls back to client_name', () => {
    expect(displayNameOf({ name: 'Nalin', whatsappGroupName: 'Ragnayor Foods <> VA' })).toBe('Ragnayor Foods')
    expect(displayNameOf({ name: 'Nalin', whatsappGroupName: null })).toBe('Nalin')
    expect(displayNameOf({ name: 'Nalin', whatsappGroupName: ' <> VA' })).toBe('Nalin')
  })
})

describe('groupClients', () => {
  const rows = [
    client({ id: 'p1', name: 'Horizon Marketing', whatsappGroupName: 'Horizon Marketing <> VA', hubspotDealId: 'd1', openTickets: 1 }),
    client({ id: 's1', name: 'Horizon Expenses', whatsappGroupName: 'Horizon Expenses', parentClientId: 'p1', openTickets: 2, openEscalations: 1 }),
    client({ id: 's2', name: 'Daily Fuel', whatsappGroupName: 'Daily Fuel Requirement', parentClientId: 'p1', status: 'Inactive' }),
    client({ id: 'o1', name: 'Amore', whatsappGroupName: 'Amore Jayanagar <> VA', hubspotDealId: '  ' }),
    client({ id: 'x1', name: 'Old Co', whatsappGroupName: 'Old Co <> VA', hubspotDealId: 'd9', status: 'Inactive' }),
    client({ id: 'xs', name: 'Old Co Payments', parentClientId: 'x1', status: 'Inactive' }),
    client({ id: 'orph', name: 'Nyvu Assets payments', parentClientId: 'hidden-parent' }),
  ]

  it('puts top-level rows in the three tabs by deal and status', () => {
    const g = groupClients(rows)
    expect(ids(g.clients)).toEqual(['p1'])
    expect(ids(g.other)).toEqual(['o1', 'orph'])
    expect(ids(g.past)).toEqual(['x1'])
  })

  it('nests subgroups inside the parent, whatever their own status, and totals their tickets', () => {
    const [h] = groupClients(rows).clients
    expect(h.displayName).toBe('Horizon Marketing')
    expect(h.subgroups.map((s) => s.client.id)).toEqual(['s2', 's1']) // by name: Daily Fuel, Horizon Expenses
    expect(h).toMatchObject({ openTickets: 3, openEscalations: 1, orphan: false, matchedBySubgroup: false })
    expect(groupClients(rows).past[0].subgroups.map((s) => s.client.id)).toEqual(['xs'])
    expect(subgroupCount(groupClients(rows).clients)).toBe(2)
  })

  it('shows a subgroup whose parent is not visible as its own row, so nothing disappears', () => {
    const g = groupClients(rows)
    const orphan = g.other.find((x) => x.client.id === 'orph')
    expect(orphan).toMatchObject({ orphan: true, subgroups: [] })
    const total = g.clients.length + g.other.length + g.past.length + subgroupCount([...g.clients, ...g.other, ...g.past])
    expect(total).toBe(rows.length)
  })

  it('folds deeper chains into the top parent and survives a parent cycle', () => {
    const g = groupClients([
      client({ id: 'a', hubspotDealId: 'd' }),
      client({ id: 'b', parentClientId: 'a' }),
      client({ id: 'c', parentClientId: 'b' }),
      client({ id: 'y', parentClientId: 'z' }),
      client({ id: 'z', parentClientId: 'y' }),
    ])
    expect(g.clients[0].subgroups.map((s) => s.client.id)).toEqual(['b', 'c'])
    const all = [...g.clients, ...g.other, ...g.past]
    expect(all.length + subgroupCount(all)).toBe(5)
  })

  it('search on a subgroup shows its parent with that subgroup marked', () => {
    const g = groupClients(rows, { search: 'expenses' })
    expect(ids(g.clients)).toEqual(['p1'])
    expect(g.clients[0].matchedBySubgroup).toBe(true)
    expect(g.clients[0].subgroups.filter((s) => s.matched).map((s) => s.client.id)).toEqual(['s1'])
    expect(g.other).toEqual([])
    expect(g.past).toEqual([])
  })

  it('search on the parent keeps all its subgroups and matches client_name and legal name too', () => {
    const g = groupClients(rows, { search: 'horizon marketing' })
    expect(g.clients[0].matchedBySubgroup).toBe(false)
    expect(g.clients[0].subgroups).toHaveLength(2)
    expect(ids(groupClients(rows, { search: 'amore' }).other)).toEqual(['o1'])
    expect(ids(groupClients([client({ id: 'l', legalName: 'Leap Pvt Ltd', hubspotDealId: 'd' })], { search: 'pvt' }).clients)).toEqual(['l'])
  })

  it('sorts by open tickets, then name, and keeps the latest activity', () => {
    const g = groupClients([
      client({ id: 'a', name: 'Bravo', hubspotDealId: 'd' }),
      client({ id: 'b', name: 'Alpha', hubspotDealId: 'd' }),
      client({ id: 'c', name: 'Zulu', hubspotDealId: 'd', openTickets: 4, lastMessageAt: '2026-11-01T00:00:00Z' }),
      client({ id: 'cs', parentClientId: 'c', lastMessageAt: '2026-11-20T00:00:00Z', unansweredCount: 2 }),
    ])
    expect(ids(g.clients)).toEqual(['c', 'b', 'a'])
    expect(g.clients[0]).toMatchObject({ lastMessageAt: '2026-11-20T00:00:00Z', waitingForReply: true })
  })
})

describe('small helpers', () => {
  it('parses the tab param with a safe default', () => {
    expect(parseClientTab('past')).toBe('past')
    expect(parseClientTab('other')).toBe('other')
    expect(parseClientTab('nope')).toBe('clients')
    expect(parseClientTab(undefined)).toBe('clients')
  })
  it('treats a blank deal id as no deal', () => {
    expect(hasHubspotDeal({ hubspotDealId: ' ' })).toBe(false)
    expect(hasHubspotDeal({ hubspotDealId: undefined })).toBe(false)
    expect(hasHubspotDeal({ hubspotDealId: '123' })).toBe(true)
  })
  it('makes initials from the display name', () => {
    expect(initialsOf('Horizon Marketing')).toBe('HM')
    expect(initialsOf('Ayurpet (Indofolk)')).toBe('A')
    expect(initialsOf('3M India')).toBe('3I')
    expect(initialsOf('')).toBe('?')
  })
})
