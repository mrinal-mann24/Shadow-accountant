import { describe, expect, it, vi } from 'vitest'

// Cards, the prefilter and every real store / client are stubbed: these tests check the scan order, statuses,
// routing, dedup and timing of the job only (the other modules have their own tests).
vi.mock('@/lib/teams/cards', () => ({
  followUpCard: (v: { id: string }, o: { what: string; ref: string; kind?: string }) => ({
    type: 'AdaptiveCard',
    version: '1.5',
    body: [],
    id: v.id,
    what: o.what,
    ref: o.ref,
    kind: o.kind,
  }),
  cardAttachment: (card: unknown) => ({
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  }),
}))
vi.mock('@/lib/teams/connector', () => ({ defaultConnector: () => null }))
vi.mock('@/lib/teams/store', () => ({
  supabaseTeamsStore: () => {
    throw new Error('real Teams store must not be used in tests')
  },
}))
vi.mock('./store', () => ({
  supabaseFollowUpStore: () => {
    throw new Error('real follow-up store must not be used in tests')
  },
  followUpViews: async () => {
    throw new Error('views must be injected in tests')
  },
}))
vi.mock('./extract', () => ({
  createFollowUpAI: () => {
    throw new Error('the model must be injected in tests')
  },
}))
vi.mock('./prefilter', async (importActual) => ({
  // isAckOnly and isHoldingReply are the real ones.
  ...(await importActual<typeof import('./prefilter')>()),
  mightBeTeamFollowUp: (b: string) => /\b(will|share|send)\b/i.test(b),
  mightBeRepeatAsk: (b: string) => /\b(again|update|still)\b/i.test(b),
}))
vi.mock('@/lib/team', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/team')>()),
  getTeamNumbers: async () => {
    throw new Error('team numbers must be injected in tests')
  },
}))

import {
  CLIENT_CONTEXT,
  MAX_SENDS_PER_RUN,
  NO_CHANNELS_NOTE,
  NO_CONNECTOR_NOTE,
  SKIPPED_NOTE,
  TEAM_CONTEXT,
  UPLOAD_OVERLAP_MS,
  inBusinessHours,
  normaliseItem,
  runFollowUpsJob,
  sameItem,
  type FollowUpsDeps,
} from './job'
import {
  FollowUpsTableMissingError,
  TABLE_MISSING_NOTE,
  followUpCycle,
  followUpRef,
  type FollowUpAI,
  type FollowUpRow,
  type FollowUpScanState,
  type FollowUpStore,
  type FollowUpView,
  type ScanMessage,
} from './types'
import type { NotificationKind, NotificationRow, OutgoingActivity, TeamsChannelMap, TeamsConnector, TeamsStore } from '@/lib/teams/types'

const TZ = 'Asia/Kolkata'
const ist = (local: string) => new Date(`${local}+05:30`).toISOString()
/** Wednesday 18 Nov 2026, 12:00 IST. */
const NOW = new Date(ist('2026-11-18T12:00:00'))
const TEAM_PHONE = '+91 90000 00009'
const CLIENT_PHONE = '9800000001'

const CLIENTS = [
  { client_id: 'c1', client_name: 'Acme', va_id: 'va1' },
  { client_id: 'c2', client_name: 'Beta', va_id: 'va2' },
]

const MAP: TeamsChannelMap = {
  serviceUrl: 'https://smba.trafficmanager.net/in/',
  tenantId: 't',
  teamId: 'team',
  accountants: { va1: { id: 'ch-va1', name: 'Asha' }, va2: { id: 'ch-va2', name: 'Bala' } },
  escalations: { id: 'ch-esc', name: 'Escalations' },
}

type Msg = ScanMessage & { created_at: string; sender_phone: string | null }
type Upload = { client_id: string; upload_id: string; file_name: string; uploaded_at: string; sender_phone: string | null }

function msg(id: string, local: string, p: { team?: boolean; body: string; client?: string }): Msg {
  const at = ist(local)
  return {
    message_id: id,
    client_id: p.client ?? 'c1',
    conversation_id: null,
    body: p.body,
    direction: p.team ? 'outgoing' : 'incoming',
    sender_name: p.team ? 'Asha' : 'Client',
    message_timestamp: at,
    created_at: new Date(new Date(at).getTime() + 30_000).toISOString(),
    sender_phone: p.team ? TEAM_PHONE : CLIENT_PHONE,
  }
}

function upload(id: string, local: string, p: { team?: boolean; client?: string; name?: string } = {}): Upload {
  return {
    client_id: p.client ?? 'c1',
    upload_id: id,
    file_name: p.name ?? `${id}.pdf`,
    uploaded_at: ist(local),
    sender_phone: p.team ? TEAM_PHONE : CLIENT_PHONE,
  }
}

type FakeStore = FollowUpStore & {
  rows: FollowUpRow[]
  messages: Msg[]
  uploads: Upload[]
  wm: FollowUpScanState
  /** Time stamped on inserted rows (the run's now). */
  at: Date
  saveWatermark: ReturnType<typeof vi.fn>
}

function fakeStore(o: { messages?: Msg[]; uploads?: Upload[]; rows?: FollowUpRow[]; clients?: typeof CLIENTS } = {}): FakeStore {
  let n = 0
  const store: FakeStore = {
    rows: o.rows ?? [],
    messages: o.messages ?? [],
    uploads: o.uploads ?? [],
    wm: { version: 2, clients: {} },
    at: NOW,
    pilotClients: async () => o.clients ?? CLIENTS,
    watermark: async () => structuredClone(store.wm),
    saveWatermark: vi.fn(async (w: FollowUpScanState) => {
      store.wm = structuredClone(w)
    }),
    newMessages: vi.fn(async (clientId: string, after: string | null, since: string | null, limit: number) =>
      store.messages
        .filter((m) => m.client_id === clientId && (!after || m.created_at > after) && (!since || m.message_timestamp >= since))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit),
    ),
    contextBefore: async (clientId, at, k) =>
      store.messages.filter((m) => m.client_id === clientId && m.message_timestamp < at).slice(-k),
    newUploads: vi.fn(async (clientId: string, after: string | null, limit: number, until?: string) =>
      store.uploads
        .filter((u) => u.client_id === clientId && (!after || u.uploaded_at > after) && (!until || u.uploaded_at <= until))
        .sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at))
        .slice(0, limit),
    ),
    open: async (clientId) =>
      store.rows
        .filter((r) => r.client_id === clientId && (r.status === 'open' || r.status === 'missed'))
        .map((r) => ({ ...r, source_at: store.messages.find((m) => m.message_id === r.source_message_id)?.message_timestamp ?? null })),
    insert: vi.fn(async (row) => {
      if (store.rows.some((r) => r.source_message_id === row.source_message_id && r.kind === row.kind && r.item === row.item)) return null
      const saved: FollowUpRow = {
        ...row,
        id: `fu${++n}`,
        status: 'open',
        resolved_at: null,
        resolved_by: null,
        resolved_message_id: null,
        resolved_upload_id: null,
        reminder_count: 0,
        last_reminded_at: null,
        escalated_at: null,
        created_at: store.at.toISOString(),
      }
      store.rows.push(saved)
      return saved
    }),
    resolve: vi.fn(async (id, p) => {
      const r = store.rows.find((x) => x.id === id)!
      Object.assign(r, {
        status: p.status,
        resolved_by: p.resolved_by,
        resolved_at: p.at,
        resolved_message_id: p.resolved_message_id ?? null,
        resolved_upload_id: p.resolved_upload_id ?? null,
      })
    }),
    markReminded: vi.fn(async (id, at) => {
      const r = store.rows.find((x) => x.id === id)!
      r.reminder_count++
      r.last_reminded_at = at
    }),
    markEscalated: vi.fn(async (id, at) => {
      store.rows.find((x) => x.id === id)!.escalated_at = at
    }),
    // Same four reads as the real store.
    alertCandidates: async (dueBefore) =>
      store.rows
        .filter(
          (r) =>
            (r.kind === 'promise' && r.status === 'open' && r.due_at !== null && r.due_at <= dueBefore) ||
            (r.kind === 'promise' && r.status === 'missed' && !r.escalated_at) ||
            (r.kind === 'document' && r.status === 'open' && r.due_at !== null && r.due_at <= dueBefore && !r.escalated_at) ||
            (r.kind === 'repeat_ask' && r.status === 'open' && !r.escalated_at),
        )
        .map((r) => ({ ...r, source_at: sourceAt(store, r) })),
    get: async (id) => store.rows.find((r) => r.id === id) ?? null,
    extend: async () => {},
  }
  return store
}

function sourceAt(store: FakeStore, r: FollowUpRow): string {
  return store.messages.find((m) => m.message_id === r.source_message_id)?.message_timestamp ?? r.created_at
}

function row(p: Partial<FollowUpRow> & { id: string; kind: FollowUpRow['kind'] }): FollowUpRow {
  return {
    client_id: 'c1',
    conversation_id: null,
    source_message_id: `src-${p.id}`,
    item: `item ${p.id}`,
    due_at: null,
    status: 'open',
    resolved_at: null,
    resolved_by: null,
    resolved_message_id: null,
    resolved_upload_id: null,
    reminder_count: 0,
    last_reminded_at: null,
    escalated_at: null,
    created_at: NOW.toISOString(),
    ...p,
  }
}

/** One client's scan state. */
const wmOf = (store: FakeStore, clientId = 'c1') => store.wm.clients[clientId] ?? {}
/** Ref n of the current alert cycle (due date day). */
const cyc = (dueAt: string) => followUpCycle(dueAt)

type FakeAI = { [K in keyof FollowUpAI]: ReturnType<typeof vi.fn> & FollowUpAI[K] }

function fakeAI(p: Partial<FollowUpAI> = {}): FakeAI {
  return {
    team: vi.fn(p.team ?? (async () => ({ promises: [], document_requests: [] }))),
    client: vi.fn(p.client ?? (async () => ({ repeat_ask: null }))),
    delivered: vi.fn(p.delivered ?? (async () => ({ delivered_ids: [] }))),
  } as FakeAI
}

type FakeTeams = TeamsStore & { rows: Map<string, NotificationRow>; released: string[] }

function fakeTeams(o: { map?: TeamsChannelMap | null; claimResult?: boolean } = {}): FakeTeams {
  const key = (k: NotificationKind, ref: string) => `${k}:${ref}`
  const rows = new Map<string, NotificationRow>()
  const s: FakeTeams = {
    rows,
    released: [],
    channels: async () => (o.map === undefined ? MAP : o.map),
    saveChannels: async () => {},
    personalChats: async () => ({}),
    savePersonalChat: async () => {},
    sentRefs: async (kind, refs) => new Set(refs.filter((r) => rows.has(key(kind, r)))),
    claim: vi.fn(async (r) => {
      if (o.claimResult === false || rows.has(key(r.kind, r.ref_id))) return false
      rows.set(key(r.kind, r.ref_id), { ...r, activity_id: null, sent_at: NOW.toISOString(), action: null, action_by: null, action_at: null })
      return true
    }),
    release: vi.fn(async (kind, ref) => {
      rows.delete(key(kind, ref))
      s.released.push(key(kind, ref))
    }),
    setActivityId: vi.fn(async (kind, ref, id) => {
      const r = rows.get(key(kind, ref))
      if (r) r.activity_id = id
    }),
    get: async (kind, ref) => rows.get(key(kind, ref)) ?? null,
    recordAction: async () => {},
    ticketForCard: async () => null,
    accountants: async () => [],
  }
  return s
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

/** Views built from the fake rows, like followUpViews does from the tables. */
function viewsOf(store: FakeStore) {
  return async (ids: string[]): Promise<FollowUpView[]> =>
    store.rows
      .filter((r) => ids.includes(r.id))
      .map((r) => {
        const c = CLIENTS.find((x) => x.client_id === r.client_id)!
        return {
          id: r.id,
          clientId: r.client_id,
          clientName: c.client_name,
          kind: r.kind,
          item: r.item,
          status: r.status,
          dueAt: r.due_at,
          createdAt: r.created_at,
          sourceAt: sourceAt(store, r),
          sourceSender: null,
          vaId: c.va_id,
          vaName: null,
          conversationId: r.conversation_id,
          reminderCount: r.reminder_count,
          resolvedAt: r.resolved_at,
          resolvedBy: r.resolved_by,
        }
      })
}

type Env = { store: FakeStore; ai: FakeAI; teams: FakeTeams; connector: ReturnType<typeof fakeConnector> }

function env(o: { store?: FakeStore; ai?: FakeAI; teams?: FakeTeams; connector?: ReturnType<typeof fakeConnector> } = {}): Env {
  return { store: o.store ?? fakeStore(), ai: o.ai ?? fakeAI(), teams: o.teams ?? fakeTeams(), connector: o.connector ?? fakeConnector() }
}

function run(e: Env, o: { write?: boolean; now?: Date; since?: string | null; budgetMs?: number } = {}, extra: Partial<FollowUpsDeps> = {}) {
  const now = o.now ?? NOW
  e.store.at = now
  return runFollowUpsJob(
    { write: o.write ?? true, now, since: o.since ?? null, budgetMs: o.budgetMs },
    {
      store: e.store,
      ai: e.ai,
      teamsStore: e.teams,
      connector: e.connector,
      views: viewsOf(e.store),
      siteUrl: 'https://shadow.test',
      teamNumbers: new Set(['9000000009']),
      timezone: TZ,
      ...extra,
    },
  )
}

const promiseAI = (due_date: string | null, due_time: string | null, item = 'GST working') =>
  fakeAI({ team: async () => ({ promises: [{ item, due_date, due_time }], document_requests: [] }) })

describe('business hours', () => {
  it('Mon to Sat 10:00 up to 19:00 IST', () => {
    expect(inBusinessHours(new Date(ist('2026-11-18T09:59:59')), TZ)).toBe(false)
    expect(inBusinessHours(new Date(ist('2026-11-18T10:00:00')), TZ)).toBe(true)
    expect(inBusinessHours(new Date(ist('2026-11-18T18:59:00')), TZ)).toBe(true)
    expect(inBusinessHours(new Date(ist('2026-11-18T19:00:00')), TZ)).toBe(false)
    expect(inBusinessHours(new Date(ist('2026-11-22T12:00:00')), TZ)).toBe(false) // Sunday
  })
})

describe('promises', () => {
  const promiseMsg = msg('m1', '2026-11-18T11:00:00', { team: true, body: 'I will send the GST working by 5 pm today' })

  it('a promise due today gets one reminder in the accountant channel', async () => {
    const e = env({ store: fakeStore({ messages: [promiseMsg] }), ai: promiseAI('2026-11-18', '17:00') })
    const first = await run(e)
    expect(first.errors).toEqual([])
    expect(e.ai.team).toHaveBeenCalledWith(expect.objectContaining({ message_id: 'm1', direction: 'outgoing' }), [], '2026-11-18')
    expect(e.store.rows).toEqual([expect.objectContaining({ kind: 'promise', item: 'GST working', due_at: ist('2026-11-18T17:00:00') })])
    expect(e.connector.sent).toEqual([
      { conversationId: 'ch-va1', card: expect.objectContaining({ what: 'due', ref: followUpRef('fu1', 'due', cyc(ist('2026-11-18T17:00:00'))) }) },
    ])
    expect(e.teams.rows.get(`reminder:${followUpRef('fu1', 'due', cyc(ist('2026-11-18T17:00:00')))}`)).toMatchObject({ client_id: 'c1', activity_id: 'act-1' })
    expect(e.store.rows[0].reminder_count).toBe(1)
    await run(e, { now: new Date(ist('2026-11-18T14:00:00')) })
    expect(e.connector.sent).toHaveLength(1)
  })

  it('no reminder before 10:00 IST, then one at 10:00', async () => {
    const early = msg('m1', '2026-11-18T08:00:00', { team: true, body: 'I will send it today' })
    const e = env({ store: fakeStore({ messages: [early] }), ai: promiseAI('2026-11-18', null) })
    await run(e, { now: new Date(ist('2026-11-18T09:59:00')) })
    expect(e.store.rows).toHaveLength(1)
    expect(e.connector.sent).toEqual([])
    await run(e, { now: new Date(ist('2026-11-18T10:00:00')) })
    expect(e.connector.sent.map((s) => s.card.what)).toEqual(['due'])
  })

  it('a later team message delivers the promise: done, never missed', async () => {
    const e = env({ store: fakeStore({ messages: [promiseMsg] }), ai: promiseAI('2026-11-18', '17:00') })
    await run(e)
    e.store.messages.push(msg('m2', '2026-11-18T16:00:00', { team: true, body: 'Here is the GST working, attached' }))
    e.ai.delivered.mockImplementation(async (_ev: unknown, open: { id: string }[]) => ({ delivered_ids: open.map((x) => x.id) }))
    const res = await run(e, { now: new Date(ist('2026-11-18T20:00:00')) })
    expect(e.ai.delivered).toHaveBeenCalledWith(
      { kind: 'message', text: 'Here is the GST working, attached', at: ist('2026-11-18T16:00:00') },
      [expect.objectContaining({ id: 'fu1', kind: 'promise' })],
    )
    expect(e.store.rows[0]).toMatchObject({ status: 'done', resolved_by: 'ai', resolved_message_id: 'm2' })
    expect(e.connector.sent.map((s) => s.card.what)).toEqual(['due'])
    expect((res.details as { alerts: { missed: string[] } }).alerts.missed).toEqual([])
  })

  it('a team file delivers the promise', async () => {
    const e = env({ store: fakeStore({ messages: [promiseMsg] }), ai: promiseAI('2026-11-18', '17:00') })
    e.store.uploads.push(upload('u1', '2026-11-18T11:30:00', { team: true, name: 'GST working.xlsx' }))
    e.ai.delivered.mockResolvedValue({ delivered_ids: ['fu1'] })
    await run(e)
    expect(e.ai.delivered).toHaveBeenCalledWith({ kind: 'file', text: 'GST working.xlsx', at: ist('2026-11-18T11:30:00') }, [
      expect.objectContaining({ id: 'fu1' }),
    ])
    expect(e.store.rows[0]).toMatchObject({ status: 'done', resolved_upload_id: 'u1' })
    expect(e.connector.sent).toEqual([])
  })

  it('a client file never delivers a promise', async () => {
    const e = env({ store: fakeStore({ messages: [promiseMsg], uploads: [upload('u1', '2026-11-18T11:30:00')] }), ai: promiseAI('2026-11-18', '17:00') })
    await run(e)
    expect(e.ai.delivered).not.toHaveBeenCalled()
    expect(e.store.rows[0].status).toBe('open')
  })

  it('past due: missed and one escalation; the next run sends nothing', async () => {
    const e = env({ store: fakeStore({ messages: [promiseMsg] }), ai: promiseAI('2026-11-18', '17:00') })
    await run(e, { now: new Date(ist('2026-11-18T11:05:00')) })
    expect(e.connector.sent.map((s) => s.card.what)).toEqual(['due'])
    await run(e, { now: new Date(ist('2026-11-18T17:05:00')) })
    expect(e.store.rows[0]).toMatchObject({ status: 'missed', resolved_by: 'ai', escalated_at: ist('2026-11-18T17:05:00') })
    expect(e.connector.sent[1]).toEqual({
      conversationId: 'ch-esc',
      card: expect.objectContaining({ what: 'missed', ref: followUpRef('fu1', 'missed', cyc(ist('2026-11-18T17:00:00'))) }),
    })
    await run(e, { now: new Date(ist('2026-11-18T17:20:00')) })
    expect(e.connector.sent).toHaveLength(2)
    expect(e.store.resolve).toHaveBeenCalledTimes(1)
  })

  it('an item found in history is marked missed, never alerted, and not read for alerts again', async () => {
    const old = msg('old', '2026-11-15T11:00:00', { team: true, body: 'I will share it tomorrow' })
    const e = env({ store: fakeStore({ messages: [old] }), ai: promiseAI('2026-11-16', null) })
    const res = await run(e)
    // escalated_at with no card: "alerts over" for this item.
    expect(e.store.rows[0]).toMatchObject({ status: 'missed', escalated_at: NOW.toISOString(), reminder_count: 0 })
    expect(e.connector.send).not.toHaveBeenCalled()
    expect(e.teams.claim).not.toHaveBeenCalled()
    expect((res.details as { alerts: { history: number } }).alerts.history).toBe(1)
    const next = await run(e, { now: new Date(ist('2026-11-18T12:15:00')) })
    expect((next.details as { alerts: { candidates: number; history: number } }).alerts).toMatchObject({ candidates: 0, history: 0 })
    expect(e.store.resolve).toHaveBeenCalledTimes(1)
  })
})

describe('documents', () => {
  const request = msg('d1', '2026-11-16T11:00:00', { team: true, body: 'Please share the October bank statement' })
  const docAI = () => fakeAI({ team: async () => ({ promises: [], document_requests: [{ item: 'October bank statement' }] }) })

  it('chased after 2 business days, every 2 business days, at most 3 times, then escalated', async () => {
    const e = env({ store: fakeStore({ messages: [request] }), ai: docAI() })
    const at = (local: string) => run(e, { now: new Date(ist(local)) })
    await at('2026-11-16T11:30:00') // Monday
    expect(e.store.rows[0]).toMatchObject({ kind: 'document', due_at: ist('2026-11-18T19:00:00') })
    await at('2026-11-18T18:50:00') // Wednesday, first chase time not reached
    expect(e.connector.sent).toEqual([])
    await at('2026-11-19T10:05:00') // Thursday
    await at('2026-11-19T15:00:00') // too soon
    await at('2026-11-21T10:05:00') // Saturday: 18 business hours later
    await at('2026-11-23T10:05:00') // Monday: only 9 business hours since Saturday
    await at('2026-11-24T10:05:00') // Tuesday
    await at('2026-11-26T10:05:00') // Thursday: 3 chases done, escalate
    await at('2026-11-26T15:05:00')
    const c = cyc(ist('2026-11-18T19:00:00'))
    expect(e.connector.sent.map((s) => [s.conversationId, s.card.ref])).toEqual([
      ['ch-va1', followUpRef('fu1', 'chase', c * 10 + 1)],
      ['ch-va1', followUpRef('fu1', 'chase', c * 10 + 2)],
      ['ch-va1', followUpRef('fu1', 'chase', c * 10 + 3)],
      ['ch-esc', followUpRef('fu1', 'missed', c)],
    ])
    expect(e.store.rows[0]).toMatchObject({ status: 'open', reminder_count: 3, escalated_at: ist('2026-11-26T10:05:00') })
  })

  it('a client file delivers the document', async () => {
    const e = env({ store: fakeStore({ messages: [request] }), ai: docAI() })
    await run(e, { now: new Date(ist('2026-11-16T11:30:00')) })
    e.store.uploads.push(upload('u9', '2026-11-17T12:00:00', { name: 'HDFC Oct.pdf' }))
    e.ai.delivered.mockResolvedValue({ delivered_ids: ['fu1', 'not-shown'] })
    await run(e, { now: new Date(ist('2026-11-17T12:05:00')) })
    expect(e.ai.delivered).toHaveBeenCalledWith({ kind: 'file', text: 'HDFC Oct.pdf', at: ist('2026-11-17T12:00:00') }, [
      expect.objectContaining({ id: 'fu1', kind: 'document' }),
    ])
    expect(e.store.rows[0]).toMatchObject({ status: 'done', resolved_upload_id: 'u9' })
    expect(e.store.resolve).toHaveBeenCalledTimes(1) // an id the model was not shown is ignored
  })

  it('a client message can deliver the document', async () => {
    const e = env({ store: fakeStore({ messages: [request] }), ai: docAI() })
    await run(e, { now: new Date(ist('2026-11-16T11:30:00')) })
    e.store.messages.push(msg('c1m', '2026-11-17T09:00:00', { body: 'Sent the statement on mail' }))
    e.ai.delivered.mockResolvedValue({ delivered_ids: ['fu1'] })
    await run(e, { now: new Date(ist('2026-11-17T09:05:00')) })
    expect(e.store.rows[0]).toMatchObject({ status: 'done', resolved_message_id: 'c1m' })
  })
})

describe('repeat asks', () => {
  it('escalation and accountant reminder at once; a later team message resolves it without a model call', async () => {
    const ask = msg('r1', '2026-11-18T11:00:00', { body: 'Any update on my GST refund? Asking again' })
    const ai = fakeAI({ client: async () => ({ repeat_ask: { item: 'GST refund status', repeats_message_id: null } }) })
    const e = env({ store: fakeStore({ messages: [ask] }), ai })
    await run(e)
    expect(ai.client).toHaveBeenCalledWith(expect.objectContaining({ message_id: 'r1', direction: 'incoming' }), [], [])
    const ref = followUpRef('fu1', 'repeat')
    expect(e.connector.sent).toEqual([
      { conversationId: 'ch-esc', card: expect.objectContaining({ what: 'repeat', ref, kind: 'escalation' }) },
      { conversationId: 'ch-va1', card: expect.objectContaining({ what: 'repeat', ref, kind: 'reminder' }) },
    ])
    expect([...e.teams.rows.keys()]).toEqual([`escalation:${ref}`, `reminder:${ref}`])
    expect(e.store.rows[0].escalated_at).toBe(NOW.toISOString())

    e.store.messages.push(msg('r2', '2026-11-18T12:10:00', { team: true, body: 'Sorry for the delay, it is filed' }))
    ai.client.mockClear()
    await run(e, { now: new Date(ist('2026-11-18T12:20:00')) })
    expect(ai.team).not.toHaveBeenCalled()
    expect(ai.client).not.toHaveBeenCalled()
    expect(ai.delivered).not.toHaveBeenCalled()
    expect(e.store.rows[0]).toMatchObject({ status: 'done', resolved_by: 'ai', resolved_message_id: 'r2' })
    expect(e.connector.sent).toHaveLength(2)
  })

  it('passes the context sizes to the store', async () => {
    const e = env({
      store: fakeStore({
        messages: [
          msg('a', '2026-11-18T10:00:00', { team: true, body: 'I will share it' }),
          msg('b', '2026-11-18T10:30:00', { body: 'still waiting' }),
        ],
      }),
    })
    const spy = vi.spyOn(e.store, 'contextBefore')
    await run(e)
    expect(spy.mock.calls.map((c) => c[2])).toEqual([TEAM_CONTEXT, CLIENT_CONTEXT])
  })
})

describe('scan', () => {
  it('a model error stops that client only and keeps its watermark before the failed message', async () => {
    const m1 = msg('m1', '2026-11-18T09:00:00', { team: true, body: 'Good morning' })
    const m2 = msg('m2', '2026-11-18T09:10:00', { team: true, body: 'I will send it' })
    const m3 = msg('m3', '2026-11-18T09:20:00', { team: true, body: 'I will share the rest' })
    const b1 = msg('b1', '2026-11-18T09:15:00', { team: true, body: 'I will send the TDS file', client: 'c2' })
    const ai = fakeAI({
      team: async (m) => {
        if (m.message_id === 'm2') throw new Error('OpenRouter 503')
        return { promises: [{ item: `from ${m.message_id}`, due_date: null, due_time: null }], document_requests: [] }
      },
    })
    const e = env({ store: fakeStore({ messages: [m1, m2, m3, b1] }), ai })
    const res = await run(e)
    expect(res.errors).toEqual(['Acme: message m2: OpenRouter 503'])
    expect(ai.team.mock.calls.map((c) => (c[0] as ScanMessage).message_id)).toEqual(['m2', 'b1'])
    expect(wmOf(e.store)).toEqual({ messages: m1.created_at, failures: { 'message:m2': 1 } })
    expect(wmOf(e.store, 'c2')).toEqual({ messages: b1.created_at })
    expect(e.store.rows.map((r) => r.item)).toEqual(['from b1'])
    // Next run starts again at m2.
    ai.team.mockImplementation(async () => ({ promises: [], document_requests: [] }))
    await run(e)
    expect(ai.team.mock.calls.slice(2).map((c) => (c[0] as ScanMessage).message_id)).toEqual(['m2', 'm3'])
    expect(wmOf(e.store)).toEqual({ messages: m3.created_at }) // the failure count is cleared on success
  })

  it('messages and files have their own watermarks; checked files are remembered', async () => {
    const m1 = msg('m1', '2026-11-18T09:00:00', { body: 'hello' })
    const e = env({ store: fakeStore({ messages: [m1], uploads: [upload('u1', '2026-11-18T09:30:00')] }) })
    await run(e)
    expect(wmOf(e.store)).toEqual({ messages: m1.created_at, uploads: ist('2026-11-18T09:30:00'), seenUploads: { u1: ist('2026-11-18T09:30:00') } })
    expect(e.store.saveWatermark).toHaveBeenCalledTimes(1)
    await run(e)
    expect(e.store.saveWatermark).toHaveBeenCalledTimes(1) // nothing new
  })

  it('passes the start date to the message read and uses it as the first file watermark', async () => {
    const since = ist('2026-11-18T00:00:00')
    const e = env({ store: fakeStore({ uploads: [upload('old', '2026-11-10T10:00:00'), upload('u1', '2026-11-18T09:00:00')] }) })
    await run(e, { since })
    expect(e.store.newMessages).toHaveBeenCalledWith('c1', null, since, 200)
    expect(wmOf(e.store)).toMatchObject({ uploads: ist('2026-11-18T09:00:00') })
    expect(wmOf(e.store).messages).toBeUndefined()
  })

  it('stops at the time budget and keeps the watermark of what was done', async () => {
    let t = 0
    const ai = fakeAI({
      team: async () => {
        t += 200_000
        return { promises: [], document_requests: [] }
      },
    })
    const m1 = msg('m1', '2026-11-18T09:00:00', { team: true, body: 'I will send it' })
    const m2 = msg('m2', '2026-11-18T09:10:00', { team: true, body: 'I will share it' })
    const e = env({ store: fakeStore({ messages: [m1, m2, msg('b1', '2026-11-18T09:00:00', { team: true, body: 'I will send', client: 'c2' })] }), ai })
    const res = await run(e, {}, { clock: () => t })
    expect(ai.team).toHaveBeenCalledTimes(1)
    expect(e.store.wm).toEqual({ version: 2, clients: { c1: { messages: m1.created_at } } })
    expect(res.details).toMatchObject({ stoppedEarly: { remainingClients: 2 } })

    const none = env({ store: fakeStore({ messages: [m1] }) })
    const stopped = await run(none, { budgetMs: 0 })
    expect(none.store.newMessages).not.toHaveBeenCalled()
    expect(stopped.details).toMatchObject({ stoppedEarly: { remainingClients: 2 } })
  })
})

describe('dry run', () => {
  it('writes nothing, calls no model, lists candidates and the cards existing rows would get', async () => {
    const store = fakeStore({
      messages: [
        msg('m1', '2026-11-18T09:00:00', { team: true, body: 'I will send it' }),
        msg('m2', '2026-11-18T09:10:00', { body: 'Still waiting, any update?' }),
        msg('m3', '2026-11-18T09:20:00', { body: 'ok thanks' }),
      ],
      rows: [
        row({ id: 'r1', kind: 'repeat_ask' }),
        row({ id: 'p1', kind: 'promise', due_at: ist('2026-11-18T11:00:00') }),
      ],
    })
    const e = env({ store })
    const res = await run(e, { write: false })
    expect(res.dryRun).toBe(true)
    expect(res.written).toBe(0)
    for (const f of [e.ai.team, e.ai.client, e.ai.delivered, store.insert, store.resolve, store.markReminded, store.markEscalated, store.saveWatermark, e.teams.claim, e.connector.send]) {
      expect(f).not.toHaveBeenCalled()
    }
    expect(store.rows.find((r) => r.id === 'p1')!.status).toBe('open')
    expect(res.details).toMatchObject({
      scan: [
        {
          clientId: 'c1',
          candidates: [
            { message_id: 'm1', check: 'team' },
            { message_id: 'm2', check: 'client' },
          ],
        },
        { clientId: 'c2', candidates: [] },
      ],
      alerts: {
        missed: ['p1'],
        cards: [
          { kind: 'escalation', what: 'repeat', followUpId: 'r1', channel: 'Escalations', status: 'would_send' },
          { kind: 'reminder', what: 'repeat', followUpId: 'r1', channel: 'Asha', status: 'would_send' },
          { kind: 'escalation', what: 'missed', followUpId: 'p1', channel: 'Escalations', status: 'would_send' },
        ],
      },
    })
  })

  it('a dry run never builds the real model client', async () => {
    const e = env({ store: fakeStore({ messages: [msg('m1', '2026-11-18T09:00:00', { team: true, body: 'I will send it' })] }) })
    const res = await run(e, { write: false }, { ai: undefined })
    expect(res.errors).toEqual([])
  })
})

describe('Teams sends', () => {
  const asks = (n: number) => Array.from({ length: n }, (_, i) => row({ id: `r${i}`, kind: 'repeat_ask' }))

  it('a lost claim skips the send', async () => {
    const e = env({ store: fakeStore({ rows: asks(1) }), teams: fakeTeams({ claimResult: false }) })
    const res = await run(e)
    expect(e.connector.send).not.toHaveBeenCalled()
    expect((res.details as { alerts: { cards: { status: string }[] } }).alerts.cards.map((c) => c.status)).toEqual(['already_sent', 'already_sent'])
  })

  it('a failed send releases its claim, records the error and is retried next run', async () => {
    let fail = true
    const e = env({ store: fakeStore({ rows: asks(1) }), connector: fakeConnector((c) => fail && c.what === 'repeat' && !!c.id) })
    const res = await run(e)
    expect(e.teams.released).toEqual([`escalation:${followUpRef('r0', 'repeat')}`, `reminder:${followUpRef('r0', 'repeat')}`])
    expect(res.errors).toEqual([
      expect.stringMatching(/escalation fu:r0:repeat:0 \(Acme\): Teams said 502/),
      expect.stringMatching(/reminder fu:r0:repeat:0 \(Acme\): Teams said 502/),
    ])
    expect(e.store.rows[0].escalated_at).toBeNull()
    fail = false
    await run(e)
    expect(e.connector.sent).toHaveLength(2)
    expect(e.store.rows[0].escalated_at).not.toBeNull()
  })

  it('an accountant with no channel goes to Escalations with an error line', async () => {
    const map: TeamsChannelMap = { ...MAP, accountants: {} }
    const e = env({ store: fakeStore({ rows: asks(1) }), teams: fakeTeams({ map }) })
    const res = await run(e)
    expect(e.connector.sent.map((s) => s.conversationId)).toEqual(['ch-esc', 'ch-esc'])
    expect(res.errors).toEqual([expect.stringMatching(/Accountant va1 \(va1\) has not opened Shadow in Teams: 1 follow-up card/)])
  })

  it('at most 25 cards a run; a half-sent pair is finished next run', async () => {
    const e = env({ store: fakeStore({ rows: asks(15) }) })
    const res = await run(e)
    expect(MAX_SENDS_PER_RUN).toBe(25)
    expect(e.connector.sent).toHaveLength(25)
    expect(res.details).toMatchObject({ alerts: { deferred: 5 } })
    expect(e.store.rows.filter((r) => r.escalated_at).length).toBe(12)
    await run(e)
    expect(e.connector.sent).toHaveLength(30)
    expect(e.store.rows.every((r) => r.escalated_at)).toBe(true)
  })

  it('no channel map: a note, no error, statuses still update', async () => {
    const p = row({ id: 'p1', kind: 'promise', due_at: ist('2026-11-18T11:00:00') })
    const e = env({ store: fakeStore({ rows: [p] }), teams: fakeTeams({ map: null }) })
    const res = await run(e)
    expect(res.errors).toEqual([])
    expect(e.store.rows[0].status).toBe('missed')
    expect(res.details).toMatchObject({ notes: [NO_CHANNELS_NOTE] })
  })

  it('write mode without the bot env: a note, statuses still update, nothing sent', async () => {
    const p = row({ id: 'p1', kind: 'promise', due_at: ist('2026-11-18T11:00:00') })
    const e = env({ store: fakeStore({ rows: [p] }) })
    const res = await run(e, {}, { connector: null })
    expect(res.errors).toEqual([])
    expect(res.fatal).toBeUndefined()
    expect(e.store.rows[0]).toMatchObject({ status: 'missed', escalated_at: null })
    expect(e.teams.claim).not.toHaveBeenCalled()
    expect(res.details).toMatchObject({ notes: [NO_CONNECTOR_NOTE] })
  })
})

// ---------------------------------------------------------------- review and QA fixes

const deliverAll = async (_ev: unknown, open: { id: string }[]) => ({ delivered_ids: open.map((x) => x.id) })

describe('1) late delivery of a missed item', () => {
  it('a missed promise is still checked and a late delivery marks it done', async () => {
    const p = msg('m1', '2026-11-18T11:00:00', { team: true, body: 'I will send the GST working by 5 pm today' })
    const e = env({ store: fakeStore({ messages: [p] }), ai: promiseAI('2026-11-18', '17:00') })
    await run(e, { now: new Date(ist('2026-11-18T17:05:00')) })
    expect(e.store.rows[0].status).toBe('missed')
    e.store.messages.push(msg('m2', '2026-11-18T18:00:00', { team: true, body: 'Sorry for the delay, GST working attached' }))
    e.ai.delivered.mockImplementation(deliverAll)
    await run(e, { now: new Date(ist('2026-11-18T18:05:00')) })
    expect(e.ai.delivered).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message' }), [expect.objectContaining({ id: 'fu1', kind: 'promise' })])
    expect(e.store.rows[0]).toMatchObject({ status: 'done', resolved_message_id: 'm2' })
  })
})

describe('2) chase escalation rest', () => {
  it('after the 3rd chase the escalation waits 2 business days, not the next run', async () => {
    const doc = row({ id: 'd1', kind: 'document', due_at: ist('2026-11-16T19:00:00'), reminder_count: 3, last_reminded_at: ist('2026-11-24T10:05:00') })
    const e = env({ store: fakeStore({ rows: [doc] }) })
    for (const t of ['2026-11-24T10:20:00', '2026-11-25T18:50:00', '2026-11-26T10:00:00']) await run(e, { now: new Date(ist(t)) })
    expect(e.connector.sent).toEqual([])
    await run(e, { now: new Date(ist('2026-11-26T10:05:00')) })
    expect(e.connector.sent.map((s) => [s.conversationId, s.card.what])).toEqual([['ch-esc', 'missed']])
  })
})

describe('3) stuck items', () => {
  it('an item that fails on two runs is skipped and reported, and the client moves on', async () => {
    const m1 = msg('m1', '2026-11-18T09:00:00', { team: true, body: 'I will send it' })
    const m2 = msg('m2', '2026-11-18T09:10:00', { team: true, body: 'I will share the rest' })
    const ai = fakeAI({
      team: async (m) => {
        if (m.message_id === 'm1') throw new Error('model said no')
        return { promises: [{ item: 'the rest', due_date: null, due_time: null }], document_requests: [] }
      },
    })
    const e = env({ store: fakeStore({ messages: [m1, m2], clients: [CLIENTS[0]] }), ai })
    const first = await run(e)
    expect(first.errors).toEqual(['Acme: message m1: model said no'])
    expect(wmOf(e.store)).toEqual({ failures: { 'message:m1': 1 } })
    const second = await run(e)
    expect(second.errors).toEqual([`Acme: message m1: ${SKIPPED_NOTE}: model said no`])
    expect(e.store.rows.map((r) => r.item)).toEqual(['the rest'])
    expect(wmOf(e.store)).toEqual({ messages: m2.created_at })
    expect((second.details as { scan: { skipped?: string[] }[] }).scan[0].skipped).toEqual(['message m1'])
    await run(e)
    expect(ai.team).toHaveBeenCalledTimes(3) // m1, m1, m2: nothing again on the third run
  })

  it('an invalid message time fails the item like a model error', async () => {
    const bad = { ...msg('m1', '2026-11-18T09:00:00', { team: true, body: 'I will send it' }), message_timestamp: 'garbage' }
    const e = env({ store: fakeStore({ messages: [bad], clients: [CLIENTS[0]] }), ai: promiseAI(null, null) })
    expect((await run(e)).errors).toEqual([expect.stringMatching(/^Acme: message m1: .*invalid date/)])
    expect((await run(e)).errors).toEqual([expect.stringMatching(new RegExp(`^Acme: message m1: ${SKIPPED_NOTE}`))])
    expect(wmOf(e.store).messages).toBe(bad.created_at)
  })
})

describe('4) separate watermarks and the upload overlap', () => {
  const request = msg('d1', '2026-11-18T11:00:00', { team: true, body: 'Please share the October bank statement' })
  const docAI = () => fakeAI({ team: async () => ({ promises: [], document_requests: [{ item: 'October bank statement' }] }) })

  it('a file logged late with an old uploaded_at is still checked, once', async () => {
    const e = env({ store: fakeStore({ messages: [request], uploads: [upload('u1', '2026-11-18T15:00:00', { name: 'GST.pdf' })], clients: [CLIENTS[0]] }), ai: docAI() })
    await run(e, { now: new Date(ist('2026-11-18T15:05:00')) })
    expect(wmOf(e.store).uploads).toBe(ist('2026-11-18T15:00:00'))
    expect(e.ai.delivered).toHaveBeenCalledTimes(1)
    // va-bot catch-up: logged at 16:00 with its WhatsApp time, 14:00, before the files watermark.
    e.store.uploads.push(upload('u2', '2026-11-18T14:00:00', { name: 'HDFC Oct.pdf' }))
    e.ai.delivered.mockImplementation(async (ev: { text: string }, open: { id: string }[]) => ({ delivered_ids: ev.text.startsWith('HDFC') ? open.map((x) => x.id) : [] }))
    await run(e, { now: new Date(ist('2026-11-18T16:05:00')) })
    expect(e.store.newUploads).toHaveBeenCalledWith('c1', new Date(Date.parse(ist('2026-11-18T15:00:00')) - UPLOAD_OVERLAP_MS).toISOString(), 1000, ist('2026-11-18T15:00:00'))
    expect(e.ai.delivered).toHaveBeenCalledTimes(2) // u2 only; u1 is remembered
    expect(e.store.rows[0]).toMatchObject({ status: 'done', resolved_upload_id: 'u2' })
    expect(Object.keys(wmOf(e.store).seenUploads ?? {}).sort()).toEqual(['u1', 'u2'])
    await run(e, { now: new Date(ist('2026-11-18T16:20:00')) })
    expect(e.ai.delivered).toHaveBeenCalledTimes(2)
  })

  it('seen uploads older than 7 days and outside the overlap are dropped', async () => {
    const e = env({ store: fakeStore({ uploads: [upload('u1', '2026-11-18T09:00:00')], clients: [CLIENTS[0]] }) })
    e.store.wm = { version: 2, clients: { c1: { uploads: ist('2026-11-18T08:00:00'), seenUploads: { old: ist('2026-11-01T09:00:00'), recent: ist('2026-11-17T09:00:00') } } } }
    await run(e)
    expect(Object.keys(wmOf(e.store).seenUploads ?? {}).sort()).toEqual(['recent', 'u1'])
  })
})

describe('5) time budget', () => {
  it('the budget is checked before every model call, not only between items', async () => {
    let t = 0
    const open = row({ id: 'p1', kind: 'promise', due_at: ist('2026-11-20T19:00:00'), source_message_id: 'src' })
    const m = msg('m1', '2026-11-18T09:00:00', { team: true, body: 'I will send the ledger too' })
    const ai = fakeAI({
      delivered: async () => {
        t += 120_000
        return { delivered_ids: [] }
      },
    })
    const e = env({ store: fakeStore({ messages: [m], rows: [open], clients: [CLIENTS[0]] }), ai })
    const res = await run(e, {}, { clock: () => t })
    expect(ai.delivered).toHaveBeenCalledTimes(1)
    expect(ai.team).not.toHaveBeenCalled() // the second call of the same message waits
    expect(res.errors).toEqual([])
    expect(wmOf(e.store).messages).toBeUndefined()
    expect(res.details).toMatchObject({ stoppedEarly: { remainingClients: 1 }, notes: [expect.stringMatching(/time budget/)] })
  })

  it('no card is sent after the alert budget; the rest are deferred and reported', async () => {
    const e = env({ store: fakeStore({ rows: [row({ id: 'r1', kind: 'repeat_ask' })] }) })
    const res = await run(e, { budgetMs: 0 }, {})
    expect(e.connector.sent).toHaveLength(2) // the scan budget does not stop alerts
    const e2 = env({ store: fakeStore({ rows: [row({ id: 'r1', kind: 'repeat_ask' })] }) })
    const res2 = await runFollowUpsJob(
      { write: true, now: NOW, since: null, alertBudgetMs: 0 },
      { store: e2.store, ai: e2.ai, teamsStore: e2.teams, connector: e2.connector, views: viewsOf(e2.store), siteUrl: 'x', teamNumbers: new Set(), timezone: TZ },
    )
    expect(e2.connector.send).not.toHaveBeenCalled()
    expect(e2.store.rows[0].escalated_at).toBeNull()
    expect(res2.details).toMatchObject({ alerts: { stoppedAtBudget: 2 }, notes: [expect.stringMatching(/Alerts stopped at the time budget: 2 card/)] })
    expect(res.errors).toEqual([])
  })
})

describe('6) duplicates across messages', () => {
  it('normalises and compares items', () => {
    expect(normaliseItem('Please share the GST-working, sir!!')).toBe('gst working')
    expect(sameItem('Share the GST working', 'Send GST working')).toBe(true)
    expect(sameItem('HDFC bank statement for October', 'Bank statement October HDFC account')).toBe(true) // 4 of 5 words
    expect(sameItem('CC statement October', 'Bank statement October')).toBe(false) // 2 of 4
    expect(sameItem('Share the MIS', 'Share the P&L')).toBe(false)
  })

  it('a promise asked again in another message is merged into the open one', async () => {
    const e = env({
      store: fakeStore({
        messages: [
          msg('m1', '2026-11-18T09:00:00', { team: true, body: 'I will share the GST working' }),
          msg('m2', '2026-11-18T10:00:00', { team: true, body: 'Sir will send GST working by tomorrow' }),
        ],
        clients: [CLIENTS[0]],
      }),
      ai: fakeAI({
        team: async (m) => ({ promises: [{ item: m.message_id === 'm1' ? 'Share the GST working' : 'Send GST working', due_date: null, due_time: null }], document_requests: [] }),
      }),
    })
    const res = await run(e)
    expect(e.store.rows.map((r) => r.item)).toEqual(['Share the GST working'])
    expect(res.details).toMatchObject({ merged: 1, scan: [{ merged: 1, inserted: 1 }] })
  })
})

describe('7) acknowledgements cost nothing', () => {
  it('no delivery check for an acknowledgement or an empty body', async () => {
    const open = row({ id: 'p1', kind: 'promise', due_at: ist('2026-11-20T19:00:00'), source_message_id: 'src' })
    const doc = row({ id: 'd1', kind: 'document', due_at: ist('2026-11-20T19:00:00'), source_message_id: 'src2' })
    const e = env({
      store: fakeStore({
        rows: [open, doc],
        messages: [
          msg('a1', '2026-11-18T09:00:00', { team: true, body: 'Ok sir, thanks 🙏' }),
          msg('a2', '2026-11-18T09:05:00', { body: 'Noted' }),
          msg('a3', '2026-11-18T09:10:00', { body: '   ' }),
        ],
        clients: [CLIENTS[0]],
      }),
    })
    await run(e)
    expect(e.ai.delivered).not.toHaveBeenCalled()
    expect(wmOf(e.store).messages).toBe(e.store.messages[2].created_at)
  })
})

describe('8) repeat asks and holding replies', () => {
  it('"Will check and revert" does not answer a repeat ask; a real reply does', async () => {
    const ask = row({ id: 'r1', kind: 'repeat_ask', source_message_id: 'src', escalated_at: NOW.toISOString() })
    const e = env({ store: fakeStore({ rows: [ask], messages: [msg('h1', '2026-11-18T12:30:00', { team: true, body: 'Will check and revert sir' })], clients: [CLIENTS[0]] }) })
    await run(e)
    expect(e.store.rows[0].status).toBe('open')
    e.store.messages.push(msg('h2', '2026-11-18T12:40:00', { team: true, body: 'Ok sir' }))
    await run(e)
    expect(e.store.rows[0].status).toBe('open')
    e.store.messages.push(msg('h3', '2026-11-18T12:50:00', { team: true, body: 'The refund is processed, ARN on mail' }))
    await run(e)
    expect(e.store.rows[0]).toMatchObject({ status: 'done', resolved_message_id: 'h3' })
  })
})

describe('9) evidence must be later than the source by message time', () => {
  it('a message logged late with an earlier message time does not resolve a promise', async () => {
    const p = msg('m1', '2026-11-18T11:00:00', { team: true, body: 'I will send the GST working today' })
    const e = env({ store: fakeStore({ messages: [p], clients: [CLIENTS[0]] }), ai: promiseAI('2026-11-18', '17:00') })
    await run(e, { now: new Date(ist('2026-11-18T11:05:00')) })
    // va-bot recovery: created now, but sent at 10:00, before the promise.
    e.store.messages.push({ ...msg('m0', '2026-11-18T10:00:00', { team: true, body: 'GST working attached' }), created_at: ist('2026-11-18T11:10:00') })
    e.store.uploads.push(upload('u0', '2026-11-18T10:30:00', { team: true, name: 'GST working.xlsx' }))
    e.ai.delivered.mockImplementation(deliverAll)
    await run(e, { now: new Date(ist('2026-11-18T11:20:00')) })
    expect(e.ai.delivered).not.toHaveBeenCalled()
    expect(e.store.rows[0].status).toBe('open')
  })
})

describe('11) business hours for every card', () => {
  it('a missed promise turns missed at once but its escalation waits for Monday 10:00', async () => {
    const p = row({ id: 'p1', kind: 'promise', due_at: ist('2026-11-21T19:00:00') }) // Saturday
    const e = env({ store: fakeStore({ rows: [p] }) })
    await run(e, { now: new Date(ist('2026-11-21T19:05:00')) })
    expect(e.store.rows[0].status).toBe('missed')
    await run(e, { now: new Date(ist('2026-11-22T12:00:00')) }) // Sunday
    await run(e, { now: new Date(ist('2026-11-23T09:50:00')) })
    expect(e.connector.sent).toEqual([])
    await run(e, { now: new Date(ist('2026-11-23T10:05:00')) })
    expect(e.connector.sent.map((s) => s.card.what)).toEqual(['missed'])
  })

  it('a repeat ask at 21:00 is escalated at 10:00 the next day', async () => {
    const e = env({ store: fakeStore({ rows: [row({ id: 'r1', kind: 'repeat_ask' })] }) })
    await run(e, { now: new Date(ist('2026-11-18T21:00:00')) })
    expect(e.connector.sent).toEqual([])
    await run(e, { now: new Date(ist('2026-11-19T10:05:00')) })
    expect(e.connector.sent).toHaveLength(2)
  })
})

describe('12) table not created yet', () => {
  it('answers with a note and no errors', async () => {
    const e = env({ store: fakeStore({ messages: [msg('m1', '2026-11-18T09:00:00', { team: true, body: 'I will send it' })] }) })
    e.store.open = async () => {
      throw new FollowUpsTableMissingError()
    }
    const res = await run(e)
    expect(res).toMatchObject({ errors: [], written: 0, details: { note: TABLE_MISSING_NOTE } })
    expect(e.ai.team).not.toHaveBeenCalled()

    const dry = env()
    dry.store.alertCandidates = async () => {
      throw Object.assign(new Error('relation "public.follow_ups" does not exist'), { code: '42P01' })
    }
    expect(await run(dry, { write: false })).toMatchObject({ dryRun: true, errors: [], details: { note: TABLE_MISSING_NOTE } })
  })
})

describe('extend starts a new alert cycle', () => {
  /** What lib/data followUpAction 'extend' does to the row. */
  const extend = (r: FollowUpRow, dueAt: string) =>
    Object.assign(r, { due_at: dueAt, status: 'open', escalated_at: null, reminder_count: 0, last_reminded_at: r.kind === 'document' ? null : r.last_reminded_at })

  it('a missed and escalated promise, extended, gets a new due card and a new escalation', async () => {
    const p = row({ id: 'p1', kind: 'promise', due_at: ist('2026-11-18T17:00:00') })
    const e = env({ store: fakeStore({ rows: [p] }) })
    await run(e, { now: new Date(ist('2026-11-18T17:05:00')) })
    expect(e.connector.sent.map((s) => s.card.ref)).toEqual([followUpRef('p1', 'missed', cyc(ist('2026-11-18T17:00:00')))])
    const newDue = ist('2026-11-19T19:00:00')
    extend(e.store.rows[0], newDue)
    await run(e, { now: new Date(ist('2026-11-19T10:05:00')) })
    await run(e, { now: new Date(ist('2026-11-19T19:05:00')) }) // missed again, escalation waits for 10:00
    await run(e, { now: new Date(ist('2026-11-20T10:05:00')) })
    expect(e.connector.sent.map((s) => s.card.ref)).toEqual([
      followUpRef('p1', 'missed', cyc(ist('2026-11-18T17:00:00'))),
      followUpRef('p1', 'due', cyc(newDue)),
      followUpRef('p1', 'missed', cyc(newDue)),
    ])
    expect(e.teams.claim).toHaveBeenCalledTimes(3)
  })

  it('a document chased 3 times and escalated, extended, gets a fresh chase 1', async () => {
    const d = row({ id: 'd1', kind: 'document', due_at: ist('2026-11-16T19:00:00'), reminder_count: 3, last_reminded_at: ist('2026-11-14T10:05:00') })
    const e = env({ store: fakeStore({ rows: [d] }) })
    await run(e)
    expect(e.connector.sent.map((s) => s.card.ref)).toEqual([followUpRef('d1', 'missed', cyc(ist('2026-11-16T19:00:00')))])
    const newDue = ist('2026-11-18T11:00:00')
    extend(e.store.rows[0], newDue)
    await run(e, { now: new Date(ist('2026-11-18T11:05:00')) })
    expect(e.connector.sent.map((s) => s.card.ref).slice(1)).toEqual([followUpRef('d1', 'chase', cyc(newDue) * 10 + 1)])
    expect(e.store.rows[0]).toMatchObject({ reminder_count: 1, escalated_at: null })
  })
})
