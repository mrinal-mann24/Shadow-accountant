import { describe, expect, it, vi } from 'vitest'

// Cards are stubbed so these tests check routing, dedup and timing only (cards.ts has its own tests).
// The stubs keep readOnly, so the tests can check which cards go out with Open in Shadow only.
vi.mock('./cards', () => ({
  ticketCard: (t: { id: string }, o: { readOnly?: boolean }) => ({
    type: 'AdaptiveCard',
    version: '1.5',
    body: [],
    kind: 'ticket',
    id: t.id,
    readOnly: o.readOnly,
  }),
  reminderCard: (t: { id: string }, o: { waitingMinutes: number; ref: string }) => ({
    type: 'AdaptiveCard',
    version: '1.5',
    body: [],
    kind: 'reminder',
    id: t.id,
    ...o,
  }),
  escalationCard: (t: { id: string }, o: { waitingMinutes: number; ref: string; accountants: unknown[] }) => ({
    type: 'AdaptiveCard',
    version: '1.5',
    body: [],
    kind: 'escalation',
    id: t.id,
    ...o,
  }),
  filesCard: (o: { clientId: string; files: { name: string; caption?: string | null }[] }) => ({
    type: 'AdaptiveCard',
    version: '1.5',
    body: [],
    kind: 'files',
    clientId: o.clientId,
    files: o.files.map((f) => f.name),
    captions: o.files.map((f) => f.caption ?? null),
  }),
  cardAttachment: (card: unknown) => ({
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  }),
}))
vi.mock('./connector', () => ({ defaultConnector: () => null }))
vi.mock('./store', () => ({
  supabaseTeamsStore: () => {
    throw new Error('real store must not be used in tests')
  },
}))
vi.mock('@/lib/team', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/team')>()),
  getTeamNumbers: async () => {
    throw new Error('team numbers must be injected in tests')
  },
}))

import {
  closedCardHandled,
  ESCALATE_AFTER_MINUTES,
  MAX_SENDS_PER_RUN,
  MAX_UPDATES_PER_RUN,
  NO_CHANNELS_ERROR,
  NO_CONNECTOR_ERROR,
  REMIND_AFTER_MINUTES,
  runTeamsNotifyJob,
  type NotifyDeps,
} from './notify'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/db/types'
import { createFakeSupabase } from '@/lib/data/testing/fake-supabase'
import {
  MAX_ROWS,
  rowLimitWarning,
  supabaseNotifyReads,
  type ClosedTicketCard,
  type NotifyReads,
  type PilotClient,
  type UploadForNotify,
} from './notify-store'
import type { AppUser } from '@/lib/auth/types'
import type {
  NotificationKind,
  NotificationRow,
  OutgoingActivity,
  PersonalChats,
  TeamsChannelMap,
  TeamsConnector,
  TeamsStore,
  TicketForCard,
} from './types'

// Monday 16 Nov 2026, 12:00 IST.
const NOW = new Date('2026-11-16T06:30:00.000Z')
const TZ = 'Asia/Kolkata'
const ist = (local: string) => new Date(`${local}+05:30`).toISOString()

const CLIENTS: PilotClient[] = [
  { clientId: 'c1', clientName: 'Acme', vaId: 'va1' },
  { clientId: 'c2', clientName: 'Beta', vaId: 'va2' },
]

const MAP: TeamsChannelMap = {
  serviceUrl: 'https://smba.trafficmanager.net/in/',
  tenantId: 't',
  teamId: 'team',
  accountants: { va1: { id: 'ch-va1', name: 'Asha' }, va2: { id: 'ch-va2', name: 'Bala' } },
  escalations: { id: 'ch-esc', name: 'Escalations' },
}

function ticket(p: Partial<TicketForCard> & { id: string }): TicketForCard {
  return {
    clientId: 'c1',
    clientName: 'Acme',
    title: 'GST query',
    summary: 'Client asked about GST',
    tag: null,
    status: 'open',
    openedAt: ist('2026-11-16T11:30:00'),
    lastMessageAt: ist('2026-11-16T11:30:00'),
    lastMessageDirection: 'incoming',
    vaId: 'va1',
    vaName: 'Asha',
    slaBreached: false,
    ...p,
  }
}

function upload(p: Partial<UploadForNotify> & { uploadId: string }): UploadForNotify {
  return {
    clientId: 'c1',
    clientName: 'Acme',
    fileName: `${p.uploadId}.pdf`,
    uploadedAt: ist('2026-11-16T11:45:00'),
    senderPhone: '9800000001',
    caption: null,
    ...p,
  }
}

/** A message our team sent in a client's group. processed: the council has read it (conversationId is its ticket, or null). */
type TeamMessage = { clientId: string; at: string; conversationId: string | null; processed: boolean }

/** Reads that apply the same filters the SQL does, from in-memory rows. */
function fakeReads(o: {
  tickets?: TicketForCard[]
  created?: Record<string, string>
  uploads?: UploadForNotify[]
  team?: TeamMessage[]
  closed?: ClosedTicketCard[]
}): NotifyReads {
  const tickets = o.tickets ?? []
  const createdAt = (t: TicketForCard) => o.created?.[t.id] ?? t.openedAt
  return {
    pilotClients: async () => CLIENTS,
    newTickets: async (clients, f) =>
      tickets.filter(
        (t) =>
          t.status === 'open' &&
          clients.some((c) => c.clientId === t.clientId) &&
          createdAt(t) >= f.createdSince &&
          t.openedAt >= f.openedSince,
      ),
    waitingTickets: async (clients, f) =>
      tickets.filter(
        (t) =>
          t.status === 'open' &&
          t.lastMessageDirection === 'incoming' &&
          clients.some((c) => c.clientId === t.clientId) &&
          t.lastMessageAt >= f.lastMessageSince,
      ),
    newUploads: async (ids, f) => (o.uploads ?? []).filter((u) => ids.includes(u.clientId) && u.uploadedAt >= f.uploadedSince),
    // Same rule as the SQL: a team message after the ticket's last client message, on this ticket or not read yet.
    repliedTickets: async (list) =>
      new Set(
        list
          .filter((t) =>
            (o.team ?? []).some(
              (m) => m.clientId === t.clientId && m.at > t.lastMessageAt && (!m.processed || m.conversationId === t.id),
            ),
          )
          .map((t) => t.id),
      ),
    closedTicketCards: async (clients, f) =>
      (o.closed ?? []).filter((c) => c.closedAt >= f.closedSince && clients.some((x) => x.clientId === c.ticket.clientId)),
  }
}

type FakeStore = TeamsStore & { rows: Map<string, NotificationRow>; released: string[]; claimResult?: boolean }

function fakeStore(
  o: { map?: TeamsChannelMap | null; rows?: NotificationRow[]; claimResult?: boolean; chats?: PersonalChats } = {},
): FakeStore {
  const key = (k: NotificationKind, ref: string) => `${k}:${ref}`
  const rows = new Map<string, NotificationRow>((o.rows ?? []).map((r) => [key(r.kind, r.ref_id), r]))
  const store: FakeStore = {
    rows,
    released: [],
    claimResult: o.claimResult,
    channels: async () => (o.map === undefined ? MAP : o.map),
    saveChannels: async () => {},
    personalChats: async () => structuredClone(o.chats ?? {}),
    savePersonalChat: async () => {},
    sentRefs: async (kind, refs) => new Set(refs.filter((r) => rows.has(key(kind, r)))),
    claim: vi.fn(async (r) => {
      if (store.claimResult === false) return false
      if (rows.has(key(r.kind, r.ref_id))) return false
      rows.set(key(r.kind, r.ref_id), {
        ...r,
        activity_id: null,
        sent_at: NOW.toISOString(),
        action: null,
        action_by: null,
        action_at: null,
      })
      return true
    }),
    release: vi.fn(async (kind, ref) => {
      rows.delete(key(kind, ref))
      store.released.push(key(kind, ref))
    }),
    setActivityId: vi.fn(async (kind, ref, id, channelId) => {
      const r = rows.get(key(kind, ref))
      if (r) r.activity_id = id
      if (r && channelId) r.channel_id = channelId
    }),
    get: async (kind, ref) => rows.get(key(kind, ref)) ?? null,
    recordAction: async () => {},
    ticketForCard: async () => null,
    accountants: async () => [
      { vaId: 'va1', name: 'Asha', email: 'asha@x.in', teamsUserId: null },
      { vaId: 'va2', name: 'Bala', email: 'bala@x.in', teamsUserId: null },
    ],
  }
  return store
}

type Sent = { conversationId: string; card: Record<string, unknown> }

function fakeConnector(fail: (card: Record<string, unknown>) => boolean = () => false): TeamsConnector & { sent: Sent[] } {
  const sent: Sent[] = []
  let n = 0
  return {
    sent,
    send: vi.fn(async (_url: string, conversationId: string, activity: OutgoingActivity) => {
      const card = activity.attachments![0].content as unknown as Record<string, unknown>
      if (fail(card)) throw new Error('Teams said 502')
      sent.push({ conversationId, card })
      return { id: `act-${++n}` }
    }),
    update: async () => {},
    member: async () => ({ email: null, name: null, aadObjectId: null }),
  }
}

function deps(p: Partial<NotifyDeps>): NotifyDeps {
  return { siteUrl: 'https://shadow.test', timezone: TZ, teamNumbers: new Set(['9000000009']), ...p }
}

const run = (d: NotifyDeps, o: { write?: boolean; now?: Date } = {}) =>
  runTeamsNotifyJob({ write: o.write ?? true, now: o.now ?? NOW }, d)

describe('runTeamsNotifyJob closed-ticket cards', () => {
  const closedCard = (p: Partial<ClosedTicketCard> & { refId: string }): ClosedTicketCard => ({
    kind: 'ticket',
    channelId: 'chat-admin',
    activityId: `act-${p.refId}`,
    ticket: ticket({ id: p.refId.split('@')[0], status: 'closed' }),
    closedAt: ist('2026-11-16T11:00:00'),
    closedBy: 'ai',
    ...p,
  })
  const closedOf = (r: { details?: unknown }) => (r.details as { closedCards?: { status: string }[] } | undefined)?.closedCards
  const chats: PersonalChats = {
    'admin@x.in': { conversationId: 'chat-admin', serviceUrl: 'https://smba.trafficmanager.net/in/', name: 'Admin', at: NOW.toISOString() },
  }

  it('says who closed it: Shadow automatically, or the team in Shadow', () => {
    expect(closedCardHandled('ai', 'x')).toMatchObject({ action: 'closed', by: 'Shadow (automatically)' })
    expect(closedCardHandled('person', 'x')).toMatchObject({ action: 'closed', by: 'the team in Shadow' })
  })

  it('a dry run lists the cards it would update and changes nothing', async () => {
    const store = fakeStore({ chats })
    const recordAction = vi.fn(async () => {})
    store.recordAction = recordAction
    const connector = fakeConnector()
    const update = vi.fn(async () => {})
    connector.update = update
    const r = await run(deps({ store, connector, reads: fakeReads({ closed: [closedCard({ refId: 't1' })] }) }), { write: false })
    expect(closedOf(r)).toEqual([{ kind: 'ticket', ref: 't1', client: 'Acme', closedBy: 'ai', status: 'would_update' }])
    expect(update).not.toHaveBeenCalled()
    expect(recordAction).not.toHaveBeenCalled()
  })

  it('a write run updates each live card in place and records the close, even when nothing new is found', async () => {
    const store = fakeStore({ chats })
    const recordAction = vi.fn(async () => {})
    store.recordAction = recordAction
    const connector = fakeConnector()
    const update = vi.fn(async () => {})
    connector.update = update
    const ref = `t2@${ist('2026-11-16T10:00:00')}`
    const r = await run(
      deps({
        store,
        connector,
        reads: fakeReads({ closed: [closedCard({ refId: 't1' }), closedCard({ refId: ref, kind: 'escalation', closedBy: 'person' })] }),
      }),
    )
    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledWith('https://smba.trafficmanager.net/in/', 'chat-admin', 'act-t1', expect.anything())
    expect(update).toHaveBeenCalledWith('https://smba.trafficmanager.net/in/', 'chat-admin', `act-${ref}`, expect.anything())
    expect(recordAction).toHaveBeenCalledWith('ticket', 't1', 'closed', 'shadow-ai', NOW.toISOString())
    expect(recordAction).toHaveBeenCalledWith('escalation', ref, 'closed', 'shadow', NOW.toISOString())
    expect(r.written).toBe(2)
    expect(connector.sent).toEqual([])
  })

  it('a failed update is reported and not recorded, so the next run tries again', async () => {
    const store = fakeStore({ chats })
    const recordAction = vi.fn(async () => {})
    store.recordAction = recordAction
    const connector = fakeConnector()
    connector.update = vi.fn(async () => {
      throw new Error('Teams said 404')
    })
    const r = await run(deps({ store, connector, reads: fakeReads({ closed: [closedCard({ refId: 't1' })] }) }))
    expect(closedOf(r)).toEqual([expect.objectContaining({ ref: 't1', status: 'failed' })])
    expect(r.errors.join(' ')).toContain('closed card ticket t1 (Acme): Teams said 404')
    expect(recordAction).not.toHaveBeenCalled()
  })

  it(`updates at most ${MAX_UPDATES_PER_RUN} per run; the rest are deferred`, async () => {
    const store = fakeStore({ chats })
    const connector = fakeConnector()
    const many = Array.from({ length: MAX_UPDATES_PER_RUN + 2 }, (_, i) => closedCard({ refId: `t${i}` }))
    const r = await run(deps({ store, connector, reads: fakeReads({ closed: many }) }), { write: false })
    const statuses = (closedOf(r) ?? []).map((c) => c.status)
    expect(statuses.filter((s) => s === 'deferred')).toHaveLength(2)
  })
})

describe('runTeamsNotifyJob new tickets', () => {
  it('never sends a history ticket (opened 3 days ago, created by the backfill just now)', async () => {
    const t = ticket({
      id: 'old',
      openedAt: ist('2026-11-13T11:00:00'),
      lastMessageAt: ist('2026-11-13T11:00:00'),
      lastMessageDirection: 'outgoing',
    })
    const connector = fakeConnector()
    const res = await run(deps({ reads: fakeReads({ tickets: [t], created: { old: NOW.toISOString() } }), store: fakeStore(), connector }))
    expect(connector.sent).toEqual([])
    expect(res.written).toBe(0)
  })

  it('sends a new ticket once to the accountant channel, and not again on the next run', async () => {
    const t = ticket({ id: 't1', lastMessageDirection: 'outgoing' })
    const store = fakeStore()
    const connector = fakeConnector()
    const d = deps({ reads: fakeReads({ tickets: [t] }), store, connector })
    const first = await run(d)
    expect(first.written).toBe(1)
    expect(first.errors).toEqual([])
    expect(connector.sent).toEqual([{ conversationId: 'ch-va1', card: expect.objectContaining({ kind: 'ticket', id: 't1' }) }])
    expect(store.rows.get('ticket:t1')).toMatchObject({ client_id: 'c1', channel_id: 'ch-va1', activity_id: 'act-1' })
    const second = await run(d)
    expect(second.written).toBe(0)
    expect(connector.sent).toHaveLength(1)
  })

  it('does not send when the claim is lost to another run', async () => {
    const store = fakeStore({ claimResult: false })
    const connector = fakeConnector()
    const res = await run(deps({ reads: fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })] }), store, connector }))
    expect(connector.send).not.toHaveBeenCalled()
    expect(res.written).toBe(0)
    expect(res.details).toMatchObject({ cards: [expect.objectContaining({ ref: 't1', status: 'already_sent' })] })
  })

  it('a failed send releases its claim, records the error and the run goes on', async () => {
    const tickets = [
      ticket({ id: 'bad', lastMessageDirection: 'outgoing' }),
      ticket({ id: 'good', clientId: 'c2', clientName: 'Beta', vaId: 'va2', lastMessageDirection: 'outgoing' }),
    ]
    const store = fakeStore()
    const connector = fakeConnector((card) => card.id === 'bad')
    const res = await run(deps({ reads: fakeReads({ tickets }), store, connector }))
    expect(store.release).toHaveBeenCalledWith('ticket', 'bad')
    expect(store.rows.has('ticket:bad')).toBe(false)
    expect(res.errors).toEqual([expect.stringMatching(/ticket bad \(Acme\): Teams said 502/)])
    expect(res.written).toBe(1)
    expect(connector.sent.map((s) => s.conversationId)).toEqual(['ch-va2'])
  })

  it('an accountant with no channel goes to Escalations with an error line', async () => {
    const map: TeamsChannelMap = { ...MAP, accountants: { va2: MAP.accountants.va2 } }
    const connector = fakeConnector()
    const res = await run(
      deps({ reads: fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })] }), store: fakeStore({ map }), connector }),
    )
    expect(connector.sent.map((s) => s.conversationId)).toEqual(['ch-esc'])
    expect(connector.sent[0].card.readOnly).toBe(false) // the Admins get the buttons
    expect(res.written).toBe(1)
    expect(res.errors).toEqual([expect.stringMatching(/Accountant Asha \(va1\) has not opened Shadow in Teams: 1 card/)])
  })

  it('skips with an error when the accountant is not reachable and nobody gets escalations', async () => {
    const map: TeamsChannelMap = { ...MAP, accountants: { va2: MAP.accountants.va2 }, escalations: null }
    const connector = fakeConnector()
    const res = await run(
      deps({ reads: fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })] }), store: fakeStore({ map }), connector }),
    )
    expect(connector.sent).toEqual([])
    expect(res.errors.join('\n')).toMatch(/Nowhere to send in Teams .*ticket t1 \(Acme\)/)
  })

  it('sends nothing, with a note and no error, when nobody has opened Shadow and nothing is linked', async () => {
    const map: TeamsChannelMap = { ...MAP, accountants: {}, escalations: null }
    const connector = fakeConnector()
    const res = await run(
      deps({ reads: fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })] }), store: fakeStore({ map }), connector }),
    )
    expect(connector.sent).toEqual([])
    expect(res.errors).toEqual([])
    expect((res.details as { note: string }).note).toBe(NO_CHANNELS_ERROR)
  })
})

describe('runTeamsNotifyJob 1:1 chats', () => {
  const SVC = 'https://smba.trafficmanager.net/in/'
  const chat = (id: string) => ({ conversationId: id, serviceUrl: SVC, name: null, at: '' })
  const people: Record<string, AppUser> = {
    'asha@x.in': { id: 'u1', email: 'asha@x.in', name: 'Asha', role: 'senior_accountant', vaId: 'va1' },
    'raghav@x.in': { id: 'u2', email: 'raghav@x.in', name: 'Raghav', role: 'admin', vaId: null },
    'priya@x.in': { id: 'u3', email: 'priya@x.in', name: 'Priya', role: 'admin', vaId: null },
    'eng@x.in': { id: 'u4', email: 'eng@x.in', name: 'Eng', role: 'engineer', vaId: null },
  }
  const chats: PersonalChats = {
    'asha@x.in': chat('a:asha'),
    'raghav@x.in': chat('a:raghav'),
    'priya@x.in': chat('a:priya'),
    'eng@x.in': chat('a:eng'),
    'gone@x.in': chat('a:gone'), // no access any more
  }
  const resolveUser = async (email: string) => people[email] ?? null
  const waiting = ticket({ id: 'w1', openedAt: ist('2026-11-14T10:00:00'), lastMessageAt: ist('2026-11-16T10:00:00') })
  const created = { w1: ist('2026-11-14T10:00:00') }

  it('sends the accountant cards to their 1:1 chat and escalations to every Admin and Engineer, never to someone without access', async () => {
    const store = fakeStore({ chats })
    const connector = fakeConnector()
    const res = await run(
      deps({
        reads: fakeReads({ tickets: [ticket({ id: 'new1', lastMessageDirection: 'outgoing' }), waiting], created }),
        store,
        connector,
        resolveUser,
      }),
    )
    const to = (kind: string) => connector.sent.filter((s) => s.card.kind === kind).map((s) => s.conversationId)
    expect(to('ticket')).toEqual(['a:asha'])
    expect(to('reminder')).toEqual(['a:asha'])
    expect(to('escalation')).toEqual(['a:raghav', 'a:priya', 'a:eng'])
    expect(connector.sent.map((s) => s.conversationId)).not.toContain('a:gone')
    expect(connector.sent.map((s) => s.conversationId)).not.toContain('ch-esc')
    // One claim row for the escalation, pointing at the first copy.
    expect(store.rows.get(`escalation:w1@${ist('2026-11-16T10:00:00')}`)).toMatchObject({ channel_id: 'a:raghav' })
    expect(res.errors).toEqual([])
    expect((res.details as { warnings?: string[] }).warnings).toEqual([expect.stringMatching(/gone@x\.in: no access/)])
  })

  it('an accountant who has not opened Shadow falls back to their linked channel; with no channel at all, to the escalation chats', async () => {
    const connector = fakeConnector()
    const t = ticket({ id: 'b1', clientId: 'c2', clientName: 'Beta', vaId: 'va2', vaName: 'Bala', lastMessageDirection: 'outgoing' })
    await run(deps({ reads: fakeReads({ tickets: [t] }), store: fakeStore({ chats }), connector, resolveUser }))
    expect(connector.sent.map((s) => s.conversationId)).toEqual(['ch-va2'])

    const none = fakeConnector()
    const res = await run(deps({ reads: fakeReads({ tickets: [t] }), store: fakeStore({ chats, map: null }), connector: none, resolveUser }))
    expect(none.sent.map((s) => s.conversationId)).toEqual(['a:raghav', 'a:priya', 'a:eng'])
    expect(res.errors).toEqual([expect.stringMatching(/Accountant Bala \(va2\) has not opened Shadow in Teams/)])
  })

  it('works with no team channels at all (only 1:1 chats)', async () => {
    const connector = fakeConnector()
    const res = await run(
      deps({ reads: fakeReads({ tickets: [ticket({ id: 'n1', lastMessageDirection: 'outgoing' })] }), store: fakeStore({ chats, map: null }), connector, resolveUser }),
    )
    expect(connector.sent.map((s) => s.conversationId)).toEqual(['a:asha'])
    expect(res.written).toBe(1)
  })

  it('one failed escalation copy keeps the claim (no resend), reports it, and points the row at a copy that went out', async () => {
    const store = fakeStore({ chats })
    const connector = fakeConnector()
    vi.mocked(connector.send).mockImplementation(async (_u, conversationId, activity) => {
      if (conversationId === 'a:raghav') throw new Error('Teams said 502')
      const card = activity.attachments![0].content as unknown as Record<string, unknown>
      connector.sent.push({ conversationId, card })
      return { id: `act-${conversationId}` }
    })
    const res = await run(deps({ reads: fakeReads({ tickets: [waiting], created }), store, connector, resolveUser }))
    const ref = `w1@${ist('2026-11-16T10:00:00')}`
    expect(store.rows.get(`escalation:${ref}`)).toMatchObject({ channel_id: 'a:priya', activity_id: 'act-a:priya' })
    expect(store.release).not.toHaveBeenCalledWith('escalation', ref)
    expect(res.errors).toEqual([expect.stringMatching(/escalation .* copy to Raghav \(1:1\): Teams said 502/)])
  })

  it("when the accountant's own lookup fails, their card waits for the next run: not sent to the Admins, not claimed", async () => {
    const store = fakeStore({ chats })
    const connector = fakeConnector()
    const flaky = async (email: string) => {
      if (email === 'asha@x.in') throw new Error('auth down')
      return people[email] ?? null
    }
    const res = await run(
      deps({ reads: fakeReads({ tickets: [ticket({ id: 'n1', lastMessageDirection: 'outgoing' })] }), store, connector, resolveUser: flaky }),
    )
    expect(connector.sent).toEqual([])
    expect(store.rows.size).toBe(0)
    expect((res.details as { held: { cards: string[] } }).held.cards).toEqual(['Asha: Acme'])
    // Next run, the lookup works again: the card goes to Asha.
    await run(deps({ reads: fakeReads({ tickets: [ticket({ id: 'n1', lastMessageDirection: 'outgoing' })] }), store, connector, resolveUser }))
    expect(connector.sent.map((s) => s.conversationId)).toEqual(['a:asha'])
  })

  it('does no role lookups when there is nothing to send', async () => {
    const lookups = vi.fn(resolveUser)
    const res = await run(deps({ reads: fakeReads({}), store: fakeStore({ chats }), connector: fakeConnector(), resolveUser: lookups }))
    expect(lookups).not.toHaveBeenCalled()
    expect(res.processed).toBe(0)
  })

  it("cards to the accountant's own 1:1 chat or channel are read-only (no Action.Execute); a fallback to the escalation chats keeps the buttons", async () => {
    const real = await vi.importActual<typeof import('./cards')>('./cards')
    const executes = (c: { actions?: unknown[] }) => (c.actions ?? []).filter((a) => (a as { type: string }).type === 'Action.Execute')
    // What the real card looks like for the options notify passed to the stub.
    const rendered = (s: Sent, t: TicketForCard) => {
      const readOnly = s.card.readOnly as boolean | undefined
      return s.card.kind === 'ticket'
        ? real.ticketCard(t, { siteUrl: 'https://shadow.test', readOnly })
        : real.reminderCard(t, { siteUrl: 'https://shadow.test', waitingMinutes: s.card.waitingMinutes as number, ref: s.card.ref as string, readOnly })
    }
    const fresh = ticket({ id: 'new1', lastMessageDirection: 'outgoing' })

    // Asha's 1:1 chat: new ticket and reminder are read-only; the escalation to the Admins is not built read-only.
    const own = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [fresh, waiting], created }), store: fakeStore({ chats }), connector: own, resolveUser }))
    const mine = own.sent.filter((s) => s.conversationId === 'a:asha')
    expect(mine.map((s) => [s.card.kind, s.card.readOnly])).toEqual([
      ['ticket', true],
      ['reminder', true],
    ])
    for (const s of mine) {
      const c = rendered(s, s.card.id === 'w1' ? waiting : fresh)
      expect(executes(c)).toEqual([])
      expect(c.actions).toEqual([expect.objectContaining({ type: 'Action.OpenUrl', title: 'Open in Shadow' })])
    }
    expect(own.sent.filter((s) => s.card.kind === 'escalation').every((s) => s.card.readOnly === undefined)).toBe(true)

    // Bala has a linked channel but no 1:1 chat: still his own route, so read-only.
    const t = ticket({ id: 'b1', clientId: 'c2', clientName: 'Beta', vaId: 'va2', vaName: 'Bala', lastMessageDirection: 'outgoing' })
    const channel = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [t] }), store: fakeStore({ chats }), connector: channel, resolveUser }))
    expect(channel.sent.map((s) => [s.conversationId, s.card.readOnly])).toEqual([['ch-va2', true]])
    expect(executes(rendered(channel.sent[0], t))).toEqual([])

    // No route of his own: the ticket card falls back to the Admins and Engineers with its buttons.
    const fallback = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [t] }), store: fakeStore({ chats, map: null }), connector: fallback, resolveUser }))
    expect(fallback.sent.map((s) => [s.conversationId, s.card.readOnly])).toEqual([
      ['a:raghav', false],
      ['a:priya', false],
      ['a:eng', false],
    ])
    expect(executes(rendered(fallback.sent[0], t)).map((a) => (a as { title: string }).title)).toEqual(['Start', 'Close', 'Not a ticket'])
  })

  it('a lookup failure skips that person with a warning and the rest still get cards', async () => {
    const connector = fakeConnector()
    const flaky = async (email: string) => {
      if (email === 'raghav@x.in') throw new Error('auth down')
      return people[email] ?? null
    }
    const res = await run(deps({ reads: fakeReads({ tickets: [waiting], created }), store: fakeStore({ chats }), connector, resolveUser: flaky }))
    expect(connector.sent.filter((s) => s.card.kind === 'escalation').map((s) => s.conversationId)).toEqual(['a:priya', 'a:eng'])
    expect((res.details as { warnings: string[] }).warnings.join('\n')).toMatch(/raghav@x\.in: lookup failed \(auth down\)/)
  })
})

describe('runTeamsNotifyJob waiting tickets', () => {
  // Tickets opened earlier than the "new" window, so only reminders / escalations are in play.
  const waitingTicket = (lastLocal: string, p: Partial<TicketForCard> = {}) =>
    ticket({ id: 'w1', openedAt: ist('2026-11-14T10:00:00'), lastMessageAt: ist(lastLocal), ...p })
  const created = { w1: ist('2026-11-14T10:00:00') }

  it('exports the thresholds', () => {
    expect(REMIND_AFTER_MINUTES).toBe(60)
    expect(ESCALATE_AFTER_MINUTES).toBe(120)
  })

  it('nothing before 60 business minutes', async () => {
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T11:01:00')], created }), store: fakeStore(), connector }))
    expect(connector.sent).toEqual([])
  })

  it('a reminder to the accountant channel at 60 business minutes, no escalation yet', async () => {
    const store = fakeStore()
    const connector = fakeConnector()
    const res = await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T11:00:00')], created }), store, connector }))
    const ref = `w1@${ist('2026-11-16T11:00:00')}`
    expect(connector.sent).toEqual([
      { conversationId: 'ch-va1', card: expect.objectContaining({ kind: 'reminder', waitingMinutes: 60, ref, readOnly: true }) },
    ])
    expect(store.rows.has(`reminder:${ref}`)).toBe(true)
    expect(res.written).toBe(1)
    // Next run: already reminded, still under 120.
    await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T11:00:00')], created }), store, connector }))
    expect(connector.sent).toHaveLength(1)
  })

  it('an escalation to Escalations at 120 business minutes, with the accountant list', async () => {
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T10:00:00')], created }), store: fakeStore(), connector }))
    const esc = connector.sent.find((s) => s.card.kind === 'escalation')
    expect(esc).toMatchObject({
      conversationId: 'ch-esc',
      card: { waitingMinutes: 120, accountants: [{ vaId: 'va1', name: 'Asha' }, { vaId: 'va2', name: 'Bala' }] },
    })
    expect(connector.sent.find((s) => s.card.kind === 'reminder')?.conversationId).toBe('ch-va1')
  })

  it('no reminder when the team replied on this ticket, or replied and the council has not read it yet (KRRD 20 Nov)', async () => {
    const connector = fakeConnector()
    const t = waitingTicket('2026-11-16T10:00:00')
    const replies: TeamMessage[] = [
      { clientId: 'c1', at: ist('2026-11-16T10:01:00'), conversationId: 'w1', processed: true },
      { clientId: 'c1', at: ist('2026-11-16T10:01:00'), conversationId: null, processed: false },
    ]
    for (const reply of replies) {
      await run(deps({ reads: fakeReads({ tickets: [t], created, team: [reply] }), store: fakeStore(), connector }))
    }
    expect(connector.sent).toEqual([])
  })

  it('not a reply: a team message the council put on another ticket or judged no_action, another group, or earlier', async () => {
    const team: TeamMessage[] = [
      { clientId: 'c1', at: ist('2026-11-16T10:30:00'), conversationId: 'other-ticket', processed: true },
      { clientId: 'c1', at: ist('2026-11-16T10:31:00'), conversationId: null, processed: true }, // "hello sir" next day: no_action
      { clientId: 'c2', at: ist('2026-11-16T10:30:00'), conversationId: null, processed: false },
      { clientId: 'c1', at: ist('2026-11-16T09:59:00'), conversationId: null, processed: false },
    ]
    for (const m of team) {
      const connector = fakeConnector()
      await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T10:00:00')], created, team: [m] }), store: fakeStore(), connector }))
      expect(connector.sent.map((x) => (x.card as { kind?: string }).kind).sort()).toEqual(['escalation', 'reminder'])
    }
  })

  it('a team reply also stops the escalation at 120 business minutes', async () => {
    const connector = fakeConnector()
    const team: TeamMessage[] = [{ clientId: 'c1', at: ist('2026-11-16T11:00:00'), conversationId: 'w1', processed: true }]
    await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T10:00:00')], created, team }), store: fakeStore(), connector }))
    expect(connector.sent).toEqual([])
  })

  it('waiting does not grow outside business hours (Sat 18:50 to Mon 10:05 is 15 minutes)', async () => {
    const connector = fakeConnector()
    const res = await run(
      deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-14T18:50:00')], created }), store: fakeStore(), connector }),
      { now: new Date(ist('2026-11-16T10:05:00')) },
    )
    expect(connector.sent).toEqual([])
    expect(res.written).toBe(0)
  })

  it('no reminder when the ticket was started after the last client message', async () => {
    const store = fakeStore({
      rows: [
        {
          kind: 'ticket',
          ref_id: 'w1',
          client_id: 'c1',
          channel_id: 'ch-va1',
          activity_id: 'a',
          sent_at: ist('2026-11-14T10:05:00'),
          action: 'started',
          action_by: 'asha@x.in',
          action_at: ist('2026-11-16T10:10:00'),
        },
      ],
    })
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T10:00:00')], created }), store, connector }))
    expect(connector.sent).toEqual([])
  })

  it('a client message after the start re-arms the reminder', async () => {
    const store = fakeStore({
      rows: [
        {
          kind: 'ticket',
          ref_id: 'w1',
          client_id: 'c1',
          channel_id: 'ch-va1',
          activity_id: 'a',
          sent_at: ist('2026-11-14T10:05:00'),
          action: 'started',
          action_by: 'asha@x.in',
          action_at: ist('2026-11-14T10:10:00'),
        },
      ],
    })
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T11:00:00')], created }), store, connector }))
    expect(connector.sent.map((s) => s.card.kind)).toEqual(['reminder'])
  })

  const ref10 = `w1@${ist('2026-11-16T10:00:00')}`
  const row = (p: Partial<NotificationRow> & { kind: NotificationKind; ref_id: string }): NotificationRow => ({
    client_id: 'c1',
    channel_id: 'ch-va1',
    activity_id: 'a',
    sent_at: ist('2026-11-16T11:00:00'),
    action: null,
    action_by: null,
    action_at: null,
    ...p,
  })

  it('Start on the reminder card only (no ticket row): no escalation at 120 minutes', async () => {
    const store = fakeStore({
      rows: [row({ kind: 'reminder', ref_id: ref10, action: 'started', action_by: 'asha@x.in', action_at: ist('2026-11-16T11:05:00') })],
    })
    const connector = fakeConnector()
    const res = await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T10:00:00')], created }), store, connector }))
    expect(connector.sent).toEqual([])
    expect(res.written).toBe(0)
  })

  it('Reassign on the escalation card stops the reminder for that waiting period', async () => {
    const store = fakeStore({
      rows: [
        row({ kind: 'escalation', ref_id: ref10, channel_id: 'ch-esc', action: 'reassigned', action_by: 'admin@x.in', action_at: ist('2026-11-16T11:30:00') }),
      ],
    })
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T10:00:00')], created }), store, connector }))
    expect(connector.sent).toEqual([])
  })

  it('a ping does not count as handled', async () => {
    const store = fakeStore({
      rows: [
        row({ kind: 'escalation', ref_id: ref10, channel_id: 'ch-esc', action: 'pinged', action_by: 'admin@x.in', action_at: ist('2026-11-16T11:30:00') }),
      ],
    })
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T10:00:00')], created }), store, connector }))
    expect(connector.sent.map((s) => s.card.kind)).toEqual(['reminder'])
  })

  it('a Start on an earlier waiting period (older ref) does not stop this one', async () => {
    const oldRef = `w1@${ist('2026-11-14T10:00:00')}`
    const store = fakeStore({
      rows: [row({ kind: 'reminder', ref_id: oldRef, action: 'started', action_at: ist('2026-11-14T12:00:00') })],
    })
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [waitingTicket('2026-11-16T10:00:00')], created }), store, connector }))
    expect(connector.sent.map((s) => s.card.kind).sort()).toEqual(['escalation', 'reminder'])
  })
})

describe('runTeamsNotifyJob lost claims (activity_id null)', () => {
  const lost = (kind: NotificationKind, ref: string, minutesAgo: number): NotificationRow => ({
    kind,
    ref_id: ref,
    client_id: 'c1',
    channel_id: 'ch-va1',
    activity_id: null,
    sent_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    action: null,
    action_by: null,
    action_at: null,
  })

  it('retries a ticket claim older than 15 minutes that never got an activity id', async () => {
    const store = fakeStore({ rows: [lost('ticket', 't1', 20)] })
    const connector = fakeConnector()
    const res = await run(deps({ reads: fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })] }), store, connector }))
    expect(store.released).toEqual(['ticket:t1'])
    expect(connector.sent).toHaveLength(1)
    expect(store.rows.get('ticket:t1')?.activity_id).toBe('act-1')
    expect(res.details).toMatchObject({ cards: [expect.objectContaining({ ref: 't1', status: 'sent', retry: true })] })
  })

  it('leaves a fresh claim (under 15 minutes) alone: it may still be sending', async () => {
    const store = fakeStore({ rows: [lost('ticket', 't1', 5)] })
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })] }), store, connector }))
    expect(store.released).toEqual([])
    expect(connector.sent).toEqual([])
  })

  it('retries a lost reminder, and never a row someone clicked', async () => {
    const waiting = ticket({ id: 'w1', openedAt: ist('2026-11-14T10:00:00'), lastMessageAt: ist('2026-11-16T11:00:00') })
    const ref = `w1@${ist('2026-11-16T11:00:00')}`
    const reads = fakeReads({ tickets: [waiting], created: { w1: ist('2026-11-14T10:00:00') } })
    const first = fakeStore({ rows: [lost('reminder', ref, 30)] })
    const connector = fakeConnector()
    await run(deps({ reads, store: first, connector }))
    expect(connector.sent.map((s) => s.card.kind)).toEqual(['reminder'])

    const clicked = fakeStore({ rows: [{ ...lost('reminder', ref, 30), action: 'pinged', action_at: NOW.toISOString() }] })
    const c2 = fakeConnector()
    await run(deps({ reads, store: clicked, connector: c2 }))
    expect(c2.sent).toEqual([])
  })

  it('does not release when another run re-claimed the row after it was read', async () => {
    const store = fakeStore({ rows: [lost('ticket', 't1', 20)] })
    const realGet = store.get
    let reads = 0
    store.get = async (kind, ref) => {
      // The second read (in sendOne) sees a newer claim by another run.
      if (kind === 'ticket' && ref === 't1' && ++reads === 2) return { ...lost('ticket', 't1', 0) }
      return realGet(kind, ref)
    }
    const connector = fakeConnector()
    const res = await run(deps({ reads: fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })] }), store, connector }))
    expect(store.released).toEqual([])
    expect(connector.sent).toEqual([])
    expect(res.details).toMatchObject({ cards: [expect.objectContaining({ ref: 't1', status: 'already_sent' })] })
  })

  it('dry run lists the retry but releases nothing', async () => {
    const store = fakeStore({ rows: [lost('ticket', 't1', 20)] })
    const res = await run(
      deps({ reads: fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })] }), store, connector: fakeConnector() }),
      { write: false },
    )
    expect(store.released).toEqual([])
    expect(res.details).toMatchObject({ cards: [expect.objectContaining({ ref: 't1', status: 'would_send', retry: true })] })
  })

  it('a lost files claim is not retried', async () => {
    const store = fakeStore({ rows: [lost('files', 'u1', 30)] })
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ uploads: [upload({ uploadId: 'u1' })] }), store, connector }))
    expect(connector.sent).toEqual([])
  })
})

describe('runTeamsNotifyJob row limits', () => {
  it('a read that hits its row limit shows in details.warnings, not errors', async () => {
    const reads = fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })] })
    const realWaiting = reads.waitingTickets
    reads.waitingTickets = async (clients, o) => {
      o.warn?.(rowLimitWarning('waiting tickets'))
      return realWaiting(clients, o)
    }
    const res = await run(deps({ reads, store: fakeStore(), connector: fakeConnector() }))
    expect(res.errors).toEqual([])
    expect(res.written).toBe(1)
    expect(res.details).toMatchObject({ warnings: ['waiting tickets: hit the 500-row limit, newest may be missing'] })
  })

  it('supabaseNotifyReads warns when a query returns exactly MAX_ROWS rows', async () => {
    const conversations = Array.from({ length: MAX_ROWS }, (_, i) => ({
      id: `t${i}`,
      client_id: 'c1',
      status: 'open',
      opened_at: ist('2026-11-16T09:00:00'),
      created_at: ist('2026-11-16T09:00:00'),
      last_message_at: ist('2026-11-16T09:00:00'),
      last_message_direction: 'incoming',
      va_id: 'va1',
      sla_breached: false,
      title: null,
      summary: 's',
      tag: null,
    }))
    const db = createFakeSupabase({ conversations, vas: [{ va_id: 'va1', va_name: 'Asha' }] }).client as unknown as SupabaseClient<Database>
    const reads = supabaseNotifyReads(db)
    const warnings: string[] = []
    const out = await reads.waitingTickets(CLIENTS, { lastMessageSince: ist('2026-11-10T00:00:00'), warn: (l) => warnings.push(l) })
    expect(out).toHaveLength(MAX_ROWS)
    expect(warnings).toEqual(['waiting tickets: hit the 500-row limit, newest may be missing'])

    const fewer = supabaseNotifyReads(
      createFakeSupabase({ conversations: conversations.slice(1), vas: [] }).client as unknown as SupabaseClient<Database>,
    )
    const none: string[] = []
    await fewer.waitingTickets(CLIENTS, { lastMessageSince: ist('2026-11-10T00:00:00'), warn: (l) => none.push(l) })
    expect(none).toEqual([])
  })
})

describe('runTeamsNotifyJob files', () => {
  it('one card per client, client files only, each upload sent once', async () => {
    const uploads = [
      upload({ uploadId: 'u1' }),
      upload({ uploadId: 'u2', senderPhone: '+91 90000 00009' }), // team number
      upload({ uploadId: 'u3', senderPhone: null }),
      upload({ uploadId: 'u4', clientId: 'c2', clientName: 'Beta' }),
      upload({ uploadId: 'old', uploadedAt: ist('2026-11-16T09:00:00') }), // older than 2 h
    ]
    const store = fakeStore()
    const connector = fakeConnector()
    const d = deps({ reads: fakeReads({ uploads }), store, connector })
    const res = await run(d)
    expect(connector.sent).toEqual([
      { conversationId: 'ch-va1', card: expect.objectContaining({ kind: 'files', clientId: 'c1', files: ['u1.pdf', 'u3.pdf'] }) },
      { conversationId: 'ch-va2', card: expect.objectContaining({ kind: 'files', clientId: 'c2', files: ['u4.pdf'] }) },
    ])
    expect(res.written).toBe(2)
    expect([...store.rows.keys()].sort()).toEqual(['files:u1', 'files:u3', 'files:u4'])
    expect(store.rows.get('files:u1')?.activity_id).toBe('act-1')
    await run(d)
    expect(connector.sent).toHaveLength(2)
  })

  it('passes the text typed under each file to the files card', async () => {
    const uploads = [upload({ uploadId: 'u1', caption: 'October bill, please book it' }), upload({ uploadId: 'u2' })]
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ uploads }), store: fakeStore(), connector }))
    expect(connector.sent).toEqual([
      { conversationId: 'ch-va1', card: expect.objectContaining({ files: ['u1.pdf', 'u2.pdf'], captions: ['October bill, please book it', null] }) },
    ])
  })

  it('a files card holds only the uploads this run claimed', async () => {
    const store = fakeStore()
    const realClaim = store.claim
    store.claim = vi.fn(async (r) => (r.ref_id === 'u1' ? false : realClaim(r)))
    const connector = fakeConnector()
    await run(deps({ reads: fakeReads({ uploads: [upload({ uploadId: 'u1' }), upload({ uploadId: 'u3' })] }), store, connector }))
    expect(connector.sent[0].card.files).toEqual(['u3.pdf'])
  })
})

describe('runTeamsNotifyJob modes and limits', () => {
  it('dry run claims nothing, sends nothing and lists every card', async () => {
    const store = fakeStore()
    const connector = fakeConnector()
    const res = await run(
      deps({
        reads: fakeReads({ tickets: [ticket({ id: 't1', lastMessageDirection: 'outgoing' })], uploads: [upload({ uploadId: 'u1' })] }),
        store,
        connector,
      }),
      { write: false },
    )
    expect(res.dryRun).toBe(true)
    expect(store.claim).not.toHaveBeenCalled()
    expect(connector.send).not.toHaveBeenCalled()
    expect(res.details).toMatchObject({
      cards: [
        { kind: 'ticket', ref: 't1', channel: 'Asha', client: 'Acme', status: 'would_send' },
        { kind: 'files', ref: 'u1', channel: 'Asha', client: 'Acme', status: 'would_send' },
      ],
    })
  })

  it('dry run works without the bot env', async () => {
    const res = await run(deps({ reads: fakeReads({}), store: fakeStore(), connector: null }), { write: false })
    expect(res.errors).toEqual([])
  })

  it('sends at most 25 cards a run and lists the rest as deferred', async () => {
    const tickets = Array.from({ length: 30 }, (_, i) => ticket({ id: `t${i}`, lastMessageDirection: 'outgoing' }))
    const store = fakeStore()
    const connector = fakeConnector()
    const d = deps({ reads: fakeReads({ tickets }), store, connector })
    const res = await run(d)
    expect(MAX_SENDS_PER_RUN).toBe(25)
    expect(connector.sent).toHaveLength(25)
    expect(res.written).toBe(25)
    expect(res.details).toMatchObject({ deferred: { count: 5 } })
    await run(d)
    expect(connector.sent).toHaveLength(30)
  })

  it('no channel map: no sends, one error, not fatal', async () => {
    const connector = fakeConnector()
    const res = await run(
      deps({ reads: fakeReads({ tickets: [ticket({ id: 't1' })] }), store: fakeStore({ map: null }), connector }),
    )
    expect(connector.send).not.toHaveBeenCalled()
    expect(res.errors).toEqual([])
    expect((res.details as { note: string }).note).toBe(NO_CHANNELS_ERROR)
    expect(res.fatal).toBeUndefined()
  })

  it('write mode without the bot env is fatal', async () => {
    const res = await run(deps({ reads: fakeReads({}), store: fakeStore(), connector: null }))
    expect(res.fatal).toBe(true)
    expect(res.errors).toEqual([NO_CONNECTOR_ERROR])
  })
})
