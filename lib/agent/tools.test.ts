import { describe, expect, it, vi } from 'vitest'
import type { AppUser } from '@/lib/auth/types'
import type { ClientDetail, ConversationItem, DocumentItem, MeetingItem } from '@/lib/data/types'
import { createCitationRegistry } from './citations'
import type { ChatScope } from './scope'
import type { AgentStore, MessageHit } from './store'
import { createChatTools, matchesAllWords, mergeHits, transcriptExcerpt, type ToolDeps } from './tools'

const user: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const clients = [
  { id: 'c1', name: 'Down The Rabbit Hole' },
  { id: 'c2', name: 'Ayurpet' },
]

function hit(id: string, clientId: string | null, at: string, body = 'gst return filed', phone: string | null = '919800000001'): MessageHit {
  return { message_id: id, client_id: clientId, message_timestamp: at, body, sender_name: 'Ravi', sender_phone: phone, direction: 'incoming' }
}

function fakeStore(over: Partial<AgentStore> = {}): AgentStore {
  return {
    searchMessagesText: vi.fn(async () => []),
    countEmbedded: vi.fn(async () => 0),
    searchMessagesVector: vi.fn(async () => []),
    meetingsWithTranscript: vi.fn(async () => []),
    ...over,
  }
}

function setup(scope: ChatScope, deps: Partial<ToolDeps> = {}) {
  const registry = createCitationRegistry(1)
  const tools = createChatTools({
    user,
    scope,
    registry,
    timeZone: 'Asia/Kolkata',
    deps: { store: fakeStore(), teamNumbers: async () => new Set(['9800000002']), embedQuery: async () => null, ...deps },
  })
  return { tools, registry }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(t: { execute?: (...args: any[]) => any }, input: unknown): Promise<any> {
  return t.execute!(input, { toolCallId: 't1', messages: [] })
}

const fixedC1: ChatScope = { clients, fixedClientId: 'c1', allClients: false }
const openScope: ChatScope = { clients, fixedClientId: null, allClients: false }

describe('searchMessages', () => {
  it('searches only the fixed client and cites each message', async () => {
    const searchMessagesText = vi.fn(async () => [hit('m1', 'c1', '2026-11-16T09:35:00Z')])
    const { tools, registry } = setup(fixedC1, { store: fakeStore({ searchMessagesText }) })
    const out = await run(tools.searchMessages, { query: 'gst return' })
    expect(searchMessagesText).toHaveBeenCalledWith('gst return', ['c1'], 12)
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toMatchObject({
      n: 1,
      client: 'Down The Rabbit Hole',
      direction: 'incoming',
      citation: {
        n: 1,
        kind: 'message',
        id: 'm1',
        clientId: 'c1',
        at: '2026-11-16T09:35:00Z',
        label: 'WhatsApp, 16 Nov 2026, 3:05 pm, Ravi',
        link: '/clients/c1#message-m1',
      },
    })
    expect(registry.all()).toHaveLength(1)
  })

  it('refuses another client when locked, without querying', async () => {
    const searchMessagesText = vi.fn(async () => [])
    const { tools } = setup(fixedC1, { store: fakeStore({ searchMessagesText }) })
    const out = await run(tools.searchMessages, { query: 'gst', clientId: 'c2' })
    expect(out.items).toEqual([])
    expect(out.error).toMatch(/not in your list/)
    expect(searchMessagesText).not.toHaveBeenCalled()
  })

  it('drops hits from clients outside scope even if the store returns them', async () => {
    const store = fakeStore({
      searchMessagesText: async () => [hit('m1', 'c1', '2026-11-16T09:00:00Z'), hit('m2', 'cX', '2026-11-16T08:00:00Z'), hit('m3', null, '2026-11-16T07:00:00Z')],
    })
    const { tools } = setup(openScope, { store })
    const out = await run(tools.searchMessages, { query: 'gst' })
    expect(out.items.map((i: { citation: { id: string } }) => i.citation.id)).toEqual(['m1'])
  })

  it('marks team senders as outgoing and labels them', async () => {
    const store = fakeStore({ searchMessagesText: async () => [hit('m1', 'c1', '2026-11-16T09:35:00Z', 'done', '+91 98000 00002')] })
    const { tools } = setup(fixedC1, { store })
    const out = await run(tools.searchMessages, { query: 'done' })
    expect(out.items[0].direction).toBe('outgoing')
  })

  it('returns an error item instead of throwing when search fails', async () => {
    const store = fakeStore({ searchMessagesText: async () => Promise.reject(new Error('boom')) })
    const { tools } = setup(fixedC1, { store })
    const out = await run(tools.searchMessages, { query: 'gst' })
    expect(out).toEqual({ items: [], error: 'Search failed: boom' })
  })

  it('uses vector search (approved) when messages are embedded', async () => {
    const store = fakeStore({ countEmbedded: vi.fn(async () => 10) })
    const embedQuery = vi.fn(async () => [0.1])
    const { tools } = setup(fixedC1, { store, embedQuery })
    await run(tools.searchMessages, { query: 'gst' })
    expect(embedQuery).toHaveBeenCalledWith('gst')
    expect(store.searchMessagesVector).toHaveBeenCalled()
  })

  it('skips vector search when nothing is embedded yet', async () => {
    const store = fakeStore({ countEmbedded: vi.fn(async () => 0) })
    const embedQuery = vi.fn(async () => [0.1])
    const { tools } = setup(fixedC1, { store, embedQuery })
    await run(tools.searchMessages, { query: 'gst' })
    expect(embedQuery).not.toHaveBeenCalled()
    expect(store.searchMessagesVector).not.toHaveBeenCalled()
  })
})

describe('getTickets / getFiles / getMeetings / getClientProfile', () => {
  const ticket: ConversationItem = {
    id: 't1', clientId: 'c1', clientName: 'Down The Rabbit Hole', vaId: 'va1', title: 'GST notice', summary: 'Client got a GST notice',
    status: 'open', tag: 'complaint', fault: 'neither', clientTone: 'calm', vaTone: 'calm', slaBreached: false,
    openedAt: '2026-11-01T10:00:00Z', openedBy: 'council', closedAt: null, lastMessageAt: '2026-11-02T10:00:00Z',
    lastMessageDirection: 'incoming', messageCount: 3,
  }
  const doc = (id: string, fileName: string): DocumentItem => ({
    id, clientId: 'c1', fileName, folderName: 'Client Files/DTRH', path: `Client Files/DTRH/${fileName}`, fileType: 'pdf',
    fileSize: 1000, uploadedAt: '2026-11-02T05:00:00Z', groupName: 'DTRH VA', url: null,
  })
  const meeting: MeetingItem = {
    id: 'mt1', clientId: 'c1', subject: 'Monthly review', start: '2026-11-10T06:30:00Z', end: null, date: null, durationMinutes: 30,
    organizerName: 'Asha', pocName: 'Ravi', meetingType: 'teams', transcriptStatus: 'done', hasTranscript: true, link: null,
  }

  it('getTickets uses the fixed client and cites tickets', async () => {
    const listConversations = vi.fn(async () => [ticket])
    const { tools } = setup(fixedC1, { listConversations })
    const out = await run(tools.getTickets, { status: 'open' })
    expect(listConversations).toHaveBeenCalledWith(user, { clientId: 'c1', status: 'open' })
    expect(out.items[0].citation).toMatchObject({ kind: 'ticket', id: 't1', label: 'Ticket GST notice, opened 1 Nov 2026' })
  })

  it('getTickets needs a client in scope when none is picked', async () => {
    const listConversations = vi.fn(async () => [ticket])
    const { tools } = setup(openScope, { listConversations })
    expect((await run(tools.getTickets, {})).error).toBeTruthy()
    expect((await run(tools.getTickets, { clientId: 'cX' })).error).toMatch(/not in your list/)
    expect(listConversations).not.toHaveBeenCalled()
  })

  it("listTicketsAcross keeps only one accountant's clients and counts per client", async () => {
    const scope: ChatScope = {
      clients: [
        { id: 'c1', name: 'Down The Rabbit Hole', accountant: 'Puneeth Kumar', openTickets: 2 },
        { id: 'c2', name: 'Ayurpet', accountant: 'Harshit', openTickets: 1 },
      ],
      fixedClientId: null,
      allClients: true,
    }
    const t2 = { ...ticket, id: 't2', slaBreached: true }
    const other = { ...ticket, id: 't3', clientId: 'c2', clientName: 'Ayurpet' }
    const outside = { ...ticket, id: 't4', clientId: 'cX', clientName: 'Hidden' }
    const listConversations = vi.fn(async () => [ticket, t2, other, outside])
    const { tools } = setup(scope, { listConversations })
    const out = await run(tools.listTicketsAcross, { accountant: 'puneeth' })
    expect(listConversations).toHaveBeenCalledWith(user, { status: 'open' })
    expect(out.items.map((i: { citation: { id: string } }) => i.citation.id)).toEqual(['t1', 't2'])
    expect(out).toMatchObject({ clientsChecked: 1, totalTickets: 2, perClient: [{ client: 'Down The Rabbit Hole', count: 2 }] })
    const breached = await run(tools.listTicketsAcross, { accountant: 'Puneeth', slaBreachedOnly: true })
    expect(breached.items.map((i: { citation: { id: string } }) => i.citation.id)).toEqual(['t2'])
  })

  it('listTicketsAcross names the known accountants when the name matches none, and refuses a locked chat', async () => {
    const scope: ChatScope = { clients: [{ id: 'c1', name: 'DTRH', accountant: 'Ajith' }], fixedClientId: null, allClients: false }
    const listConversations = vi.fn(async () => [ticket])
    const { tools } = setup(scope, { listConversations })
    const out = await run(tools.listTicketsAcross, { accountant: 'Puneeth' })
    expect(out).toMatchObject({ items: [], accountants: ['Ajith'] })
    expect((await run(setup(fixedC1, { listConversations }).tools.listTicketsAcross, {})).error).toMatch(/getTickets/)
    expect(listConversations).not.toHaveBeenCalled()
  })

  it('getFiles filters by words and cites the file name', async () => {
    const listDocuments = vi.fn(async () => [doc('f1', 'HDFC Bank Statement Oct.pdf'), doc('f2', 'Sales Oct.xlsx')])
    const { tools } = setup(fixedC1, { listDocuments })
    const out = await run(tools.getFiles, { query: 'bank statement' })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].citation).toMatchObject({ kind: 'file', id: 'f1', label: 'File HDFC Bank Statement Oct.pdf, 2 Nov 2026', link: '/clients/c1#file-f1' })
  })

  it('getMeetings adds a transcript excerpt for the same client only', async () => {
    const store = fakeStore({
      meetingsWithTranscript: async () => [
        { id: 'mt1', client_id: 'c1', subject: null, meeting_start: null, meeting_date: null, teams_url: null, transcript: 'We discussed the TDS return and payroll.' },
      ],
    })
    const { tools } = setup(fixedC1, { store, listMeetings: async () => [meeting] })
    const out = await run(tools.getMeetings, { query: 'tds' })
    expect(out.items[0].excerpt).toContain('TDS return')
    expect(out.items[0].citation).toMatchObject({ kind: 'meeting', id: 'mt1', label: 'Meeting Monthly review, 10 Nov 2026, 12:00 pm' })
  })

  it('getClientProfile cites the profile and leaves out contact phone numbers', async () => {
    const detail = {
      id: 'c1', name: 'Down The Rabbit Hole', legalName: null, status: 'active', dealStage: null, vaId: 'va1', vaName: 'Asha',
      whatsappGroupName: null, councilEnabled: false, parentClientId: null, serviceScore: 80, moodScore: 70, serviceDelta: null,
      moodDelta: null, scoreComputedAt: null, lastMessageAt: null, unansweredCount: 0, worstLagMinutes: null, openTickets: 1,
      openEscalations: 0, email: null, gstin: '29ABCDE1234F1Z5', entityType: null, industry: null, city: null, state: null,
      onboardingDate: null, hubspotDealId: null, whatsappGroupId: null, topReasons: [],
      contacts: [{ id: 'k1', name: 'Ravi', role: 'Owner', whatsappNumber: '919800000001', isPrimary: true }],
    } satisfies ClientDetail
    const { tools } = setup(fixedC1, { getClient: async () => detail })
    const out = await run(tools.getClientProfile, {})
    expect(out.items[0].citation).toMatchObject({ kind: 'client', id: 'c1', at: null, label: 'Client profile, Down The Rabbit Hole', link: '/clients/c1' })
    expect(JSON.stringify(out)).not.toContain('919800000001')
  })

  it('getClientProfile reports a missing client', async () => {
    const { tools } = setup(fixedC1, { getClient: async () => null })
    expect(await run(tools.getClientProfile, {})).toEqual({ items: [], error: 'Client not found.' })
  })

  it('numbers continue across tools in one request', async () => {
    const store = fakeStore({ searchMessagesText: async () => [hit('m1', 'c1', '2026-11-16T09:35:00Z')] })
    const { tools } = setup(fixedC1, { store, listConversations: async () => [ticket] })
    const a = await run(tools.searchMessages, { query: 'gst' })
    const b = await run(tools.getTickets, {})
    expect([a.items[0].n, b.items[0].n]).toEqual([1, 2])
  })
})

describe('helpers', () => {
  it('mergeHits keeps text hits first, removes duplicates and out of scope rows', () => {
    const t = [hit('a', 'c1', '3'), hit('b', 'c2', '2')]
    const v = [hit('b', 'c2', '2'), hit('c', 'c1', '1'), hit('d', 'cX', '1')]
    expect(mergeHits(t, v, ['c1', 'c2'], 10).map((h) => h.message_id)).toEqual(['a', 'b', 'c'])
    expect(mergeHits(t, v, null, 2).map((h) => h.message_id)).toEqual(['a', 'b'])
  })
  it('matchesAllWords', () => {
    expect(matchesAllWords('Client Files/HDFC Bank Statement.pdf', 'bank hdfc')).toBe(true)
    expect(matchesAllWords('Sales.xlsx', 'bank')).toBe(false)
    expect(matchesAllWords('anything', undefined)).toBe(true)
  })
  it('transcriptExcerpt centres on the query word', () => {
    const long = `${'intro '.repeat(100)}the GSTR-3B was late ${'outro '.repeat(100)}`
    const ex = transcriptExcerpt(long, 'gstr-3b')
    expect(ex).toContain('GSTR-3B was late')
    expect(ex.startsWith('...')).toBe(true)
    expect(transcriptExcerpt(null, 'x')).toBe('')
    expect(transcriptExcerpt('short text', null)).toBe('short text')
  })
})
