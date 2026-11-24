import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'
import { followUpRef, type FollowUpAction, type FollowUpView } from '@/lib/followups/types'
import {
  AI_FAILED,
  ALREADY_CLOSED,
  ALREADY_DONE,
  cleanText,
  DIRECT_ONLY,
  FOLLOW_UP_CLOSED,
  FOLLOW_UP_NO_EXTEND,
  FOLLOW_UP_NOT_FOUND,
  formatAnswer,
  handleActivity,
  INVALID_CARD,
  MAX_QUESTION,
  MAX_QUESTIONS,
  NEW_CHAT_DONE,
  NO_ACCOUNTANT_CHAT,
  NOT_SET_UP,
  NOTHING_TO_SAVE,
  OTHER_TEAM,
  PING_FAILED,
  REFUSAL,
  resetBotState,
  SAVE_EXPIRED,
  SAVE_GONE,
  setupLine,
  TOO_MANY,
  type BotDeps,
} from './bot'
import type { PendingMeta, PendingSave, TeamsChatStore } from './chat'
import type { SaveTranscriptInput } from '@/lib/data/transcripts'
import type {
  Activity,
  AskShadow,
  NotificationRow,
  PersonalChat,
  PersonalChats,
  OutgoingActivity,
  TeamsChannelMap,
  TeamsStore,
  TicketForCard,
} from './types'

const TENANT = 'tenant-1'
const SITE = 'https://shadow.example'
const SVC = 'https://smba.trafficmanager.net/in/'
const NOW = new Date('2026-11-18T06:00:00.000Z')
// Reminder / escalation refs are '<ticketId>@<last message time>' (notify.ts waitRef).
const E1 = 't1@2026-11-18T05:00:00.000Z'
const R1 = 't1@2026-11-18T05:00:00.000Z'
// Senior Accountants work in Shadow: any card click from them gets this message and changes nothing (bot.ts).
const USE_SHADOW = 'Please update this in Shadow: press Open in Shadow on the card.'
const ADMIN = 'admin@x.in'

const users: Record<string, AppUser> = {
  'asha@x.in': { id: 'u1', email: 'asha@x.in', name: 'Asha', role: 'senior_accountant', vaId: 'va-1' },
  'ravi@x.in': { id: 'u2', email: 'ravi@x.in', name: 'Ravi', role: 'senior_accountant', vaId: 'va-2' },
  'admin@x.in': { id: 'u3', email: 'admin@x.in', name: 'Admin One', role: 'admin', vaId: null },
  'eng@x.in': { id: 'u4', email: 'eng@x.in', name: 'Eng One', role: 'engineer', vaId: null },
}

const ticket: TicketForCard = {
  id: 't1',
  clientId: 'c1',
  clientName: 'Acme Traders',
  title: 'GST query',
  summary: 'Client asked about GSTR-3B',
  tag: 'gst',
  status: 'open',
  openedAt: '2026-11-18T04:00:00.000Z',
  lastMessageAt: '2026-11-18T05:00:00.000Z',
  lastMessageDirection: 'incoming',
  vaId: 'va-1',
  vaName: 'Asha',
  slaBreached: false,
}

const fuView: FollowUpView = {
  id: 'f1',
  clientId: 'c1',
  clientName: 'Acme Traders',
  kind: 'promise',
  item: 'Send the GSTR-3B working',
  status: 'open',
  dueAt: '2026-11-18T12:30:00.000Z',
  createdAt: '2026-11-18T05:00:00.000Z',
  sourceAt: '2026-11-18T04:00:00.000Z',
  sourceSender: 'Asha',
  vaId: 'va-1',
  vaName: 'Asha',
  conversationId: 'conv-1',
  reminderCount: 0,
  resolvedAt: null,
  resolvedBy: null,
}

type Sent = { serviceUrl: string; conversationId: string; activity: OutgoingActivity }

// Each setup is a fresh server instance (module memory cleared) unless keepState is set.
function setup(
  o: {
    email?: string | null
    map?: TeamsChannelMap | null
    rows?: NotificationRow[]
    now?: () => Date
    keepState?: boolean
    ticketStatus?: string
    chats?: PersonalChats
  } = {},
) {
  if (!o.keepState) resetBotState()
  const sent: Sent[] = []
  const updated: { conversationId: string; activityId: string; activity: OutgoingActivity }[] = []
  const tasks: (() => Promise<void>)[] = []
  const recorded: { kind: string; ref: string; action: string; by: string; at: string }[] = []
  let map: TeamsChannelMap | null = o.map === undefined ? null : o.map
  const saved: TeamsChannelMap[] = []
  // Everyone has opened the Shadow chat already (the 1:1 test conversation), unless the test says otherwise.
  const chats: PersonalChats =
    o.chats ??
    Object.fromEntries(Object.keys(users).map((email) => [email, { conversationId: 'a:1on1', serviceUrl: SVC, name: null, at: '' }]))
  const rows = o.rows ?? []

  const store: TeamsStore = {
    channels: async () => (map ? structuredClone(map) : null),
    saveChannels: async (m) => {
      map = structuredClone(m)
      saved.push(structuredClone(m))
    },
    personalChats: async () => structuredClone(chats),
    savePersonalChat: vi.fn(async (email: string, chat: PersonalChat) => {
      chats[email] = { ...chat }
    }),
    sentRefs: async () => new Set(),
    claim: async () => true,
    release: async () => {},
    setActivityId: async () => {},
    get: async (kind, ref) => rows.find((r) => r.kind === kind && r.ref_id === ref) ?? null,
    recordAction: async (kind, ref, action, by, at) => {
      recorded.push({ kind, ref, action, by, at })
    },
    ticketForCard: async (id) => (id === ticket.id ? { ...ticket } : null),
    accountants: async () => [
      { vaId: 'va-1', name: 'Asha', email: 'Asha@X.in', teamsUserId: '29:asha' },
      { vaId: 'va-2', name: 'Ravi', email: 'ravi@x.in', teamsUserId: null },
    ],
  }

  const data = {
    updateConversation: vi.fn(async (user: AppUser, id: string) => {
      if (user.role === 'engineer') throw new ForbiddenError()
      if (id !== ticket.id) throw new Error('Ticket not found.')
      if (user.role === 'senior_accountant' && user.vaId !== ticket.vaId) throw new ForbiddenError()
    }),
    ticketForUser: vi.fn(async (user: AppUser, id: string) => {
      if (id !== ticket.id) return null
      if (user.role === 'senior_accountant' && user.vaId !== ticket.vaId) return null
      return { id: ticket.id, clientId: ticket.clientId, vaId: ticket.vaId, status: o.ticketStatus ?? ticket.status }
    }),
    reassignTicket: vi.fn(async (user: AppUser) => {
      if (user.role !== 'admin') throw new ForbiddenError()
    }),
  }

  const followUps = {
    action: vi.fn(async (user: AppUser, id: string, action: FollowUpAction): Promise<FollowUpView> => {
      if (user.role === 'engineer') throw new ForbiddenError()
      if (user.role === 'senior_accountant' && user.vaId !== fuView.vaId) throw new ForbiddenError()
      if (id !== fuView.id) throw new Error('Follow-up not found.')
      if (action === 'extend') return { ...fuView, dueAt: '2026-11-19T12:30:00.000Z' }
      return { ...fuView, status: action === 'done' ? 'done' : 'cancelled' }
    }),
  }

  const ask = vi.fn<AskShadow>(async () => ({
    text: 'Acme filed GSTR-3B on 20 Oct [1].',
    citations: [
      { n: 1, label: 'WhatsApp message, 20 Oct 10:15', link: '/clients/c1/timeline?m=9' },
      { n: 2, label: 'Return [PDF]', link: 'https://sharepoint.example/doc 1.pdf' },
      { n: 3, label: 'Meeting at 12:30' },
    ],
  }))

  const chatRows: { id: string; email: string; kind: string; content: string; meta: PendingMeta | null; created_at: string }[] = []
  let chatSeq = 0
  const nowIso = () => (o.now ?? (() => NOW))().toISOString()
  const asPending = (r: (typeof chatRows)[number]): PendingSave => ({
    id: r.id,
    email: r.email,
    content: r.content,
    meta: r.meta as PendingMeta,
    createdAt: r.created_at,
  })
  const chat: TeamsChatStore = {
    recentTurns: vi.fn(async (email: string, since: string, limit: number) =>
      chatRows
        .filter((r) => r.email === email.toLowerCase() && (r.kind === 'user' || r.kind === 'assistant') && r.created_at > since)
        .slice(-limit)
        .map((r) => ({ kind: r.kind as 'user' | 'assistant', content: r.content, created_at: r.created_at })),
    ),
    addTurns: vi.fn(async (email: string, turns: { kind: 'user' | 'assistant'; content: string }[]) => {
      for (const t of turns) chatRows.push({ id: `row-${++chatSeq}`, email: email.toLowerCase(), kind: t.kind, content: t.content, meta: null, created_at: nowIso() })
    }),
    clear: vi.fn(async (email: string) => {
      for (let i = chatRows.length - 1; i >= 0; i--) {
        if (chatRows[i].email === email.toLowerCase() && chatRows[i].kind !== 'pending_save') chatRows.splice(i, 1)
      }
    }),
    addPending: vi.fn(async (email: string, content: string, meta: PendingMeta) => {
      const id = `p-${++chatSeq}`
      chatRows.push({ id, email: email.toLowerCase(), kind: 'pending_save', content, meta, created_at: nowIso() })
      return id
    }),
    getPending: vi.fn(async (id: string, email: string) => {
      const r = chatRows.find((x) => x.id === id && x.email === email.toLowerCase() && x.kind === 'pending_save')
      return r ? asPending(r) : null
    }),
    takePending: vi.fn(async (id: string, email: string) => {
      const i = chatRows.findIndex((x) => x.id === id && x.email === email.toLowerCase() && x.kind === 'pending_save')
      if (i < 0) return null
      return asPending(chatRows.splice(i, 1)[0])
    }),
    prune: vi.fn(async () => 0),
  }
  const saveTranscript = vi.fn(async (user: AppUser, input: SaveTranscriptInput) => {
    if (user.role === 'senior_accountant' && input.clientId !== 'c1') throw new ForbiddenError()
    return { id: 'mt-1' }
  })

  const deps: BotDeps = {
    chat,
    saveTranscript,
    connector: {
      send: vi.fn(async (serviceUrl: string, conversationId: string, activity: OutgoingActivity) => {
        sent.push({ serviceUrl, conversationId, activity })
        return { id: `act-${sent.length}` }
      }),
      update: vi.fn(async (_s: string, conversationId: string, activityId: string, activity: OutgoingActivity) => {
        updated.push({ conversationId, activityId, activity })
      }),
      member: vi.fn(async () => ({ email: o.email === undefined ? 'asha@x.in' : o.email, name: null, aadObjectId: null })),
    },
    store,
    resolveUser: vi.fn(async (email: string) => users[email.toLowerCase()] ?? null),
    ask,
    data,
    followUps,
    siteUrl: SITE,
    tenantId: TENANT,
    now: o.now ?? (() => NOW),
    defer: (task) => {
      tasks.push(task)
    },
  }
  const runDeferred = async () => {
    for (const t of tasks.splice(0)) await t()
  }
  return { deps, sent, updated, tasks, runDeferred, recorded, saved, data, followUps, ask, chat, chatRows, saveTranscript, chats, store, getMap: () => map }
}

function base(over: Partial<Activity> = {}): Activity {
  return {
    type: 'message',
    serviceUrl: SVC,
    channelId: 'msteams',
    from: { id: '29:user', name: 'Someone' },
    recipient: { id: '28:bot', name: 'Shadow' },
    conversation: { id: 'a:1on1', tenantId: TENANT, conversationType: 'personal' },
    channelData: { tenant: { id: TENANT } },
    ...over,
  }
}

const channelActivity = (text: string): Activity =>
  base({
    text,
    conversation: { id: '19:chan@thread.tacv2;messageid=123', tenantId: TENANT, conversationType: 'channel' },
    channelData: { tenant: { id: TENANT }, team: { id: '19:team@thread.tacv2' }, channel: { id: '19:chan@thread.tacv2', name: 'Asha tickets' } },
  })

const click = (data: Record<string, unknown>): Activity =>
  base({
    type: 'invoke',
    name: 'adaptiveCard/action',
    value: { action: { type: 'Action.Execute', verb: 'ticket', data } },
  })

type InvokeBody = { statusCode: number; type: string; value: unknown }
const body = (r: { body?: unknown }) => r.body as InvokeBody

function cardText(v: unknown): string {
  return JSON.stringify(v)
}

const emptyMap = (): TeamsChannelMap => ({ serviceUrl: SVC, tenantId: TENANT, teamId: '19:team@thread.tacv2', accountants: {}, escalations: null })

// ---------------------------------------------------------------- tenant and identity

describe('tenant and identity', () => {
  it('refuses another tenant with 403 and does nothing', async () => {
    const s = setup()
    const r = await handleActivity(base({ text: 'help', channelData: { tenant: { id: 'evil' } } }), s.deps)
    expect(r.status).toBe(403)
    expect(s.sent).toHaveLength(0)
    expect(s.deps.connector.member).not.toHaveBeenCalled()
  })

  it('falls back to conversation.tenantId, and a missing tenant is refused', async () => {
    const s = setup()
    const ok = await handleActivity(base({ text: 'help', channelData: {} }), s.deps)
    expect(ok.status).toBe(200)
    const none = await handleActivity(base({ text: 'help', channelData: {}, conversation: { id: 'a:1' } }), s.deps)
    expect(none.status).toBe(403)
  })

  it('an unknown Teams user gets the not set up reply and no AI call', async () => {
    const s = setup({ email: 'stranger@x.in' })
    const r = await handleActivity(base({ text: 'what is pending for Acme?' }), s.deps)
    expect(r.status).toBe(200)
    expect(s.sent[0].activity.text).toBe(NOT_SET_UP)
    expect(s.tasks).toHaveLength(0)
    expect(s.ask).not.toHaveBeenCalled()
  })

  it('a member with no email is not set up, also on a card click', async () => {
    const s = setup({ email: null })
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(body(r)).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: NOT_SET_UP })
  })
})

// ---------------------------------------------------------------- card actions

describe('card actions', () => {
  it('invalid card data answers a BadRequest invoke error', async () => {
    const s = setup()
    const r = await handleActivity(click({ action: 'explode', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(r.status).toBe(200)
    expect(body(r).statusCode).toBe(400)
    expect(body(r).type).toBe('application/vnd.microsoft.error')
    expect((body(r).value as { code: string }).code).toBe('BadRequest')
    expect(s.recorded).toHaveLength(0)
  })

  it('start: an admin records started and returns the handled card; updates the stored card', async () => {
    const s = setup({
      email: ADMIN,
      rows: [
        { kind: 'ticket', ref_id: 't1', client_id: 'c1', channel_id: '19:chan', activity_id: 'act-9', sent_at: '', action: null, action_by: null, action_at: null },
      ],
    })
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(body(r).statusCode).toBe(200)
    expect(body(r).type).toBe('application/vnd.microsoft.card.adaptive')
    expect(cardText(body(r).value)).toContain('Started by Admin One')
    expect(cardText(body(r).value)).not.toContain('Action.Execute')
    expect(s.recorded).toEqual([{ kind: 'ticket', ref: 't1', action: 'started', by: ADMIN, at: NOW.toISOString() }])
    expect(s.updated).toHaveLength(0) // after the invoke answer
    await s.runDeferred()
    expect(s.updated).toHaveLength(1)
    expect(s.updated[0]).toMatchObject({ conversationId: '19:chan', activityId: 'act-9' })
  })

  it('start from a reminder also records on the ticket row; a failing card update is ignored', async () => {
    const s = setup({
      email: ADMIN,
      rows: [
        { kind: 'reminder', ref_id: R1, client_id: 'c1', channel_id: '19:chan', activity_id: 'act-2', sent_at: '', action: null, action_by: null, action_at: null },
      ],
    })
    vi.mocked(s.deps.connector.update).mockRejectedValueOnce(new Error('boom'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'reminder', ref: R1 }), s.deps)
    expect(body(r).type).toBe('application/vnd.microsoft.card.adaptive')
    await s.runDeferred()
    expect(err).toHaveBeenCalledWith('[teams-bot] card update failed:', 'boom')
    err.mockRestore()
    expect(s.recorded.map((x) => `${x.kind}:${x.ref}:${x.action}`)).toEqual([`reminder:${R1}:started`, 'ticket:t1:started'])
  })

  it('a senior accountant (own client or another) clicking start, close or not_ticket is told to use Shadow; nothing changes', async () => {
    const rows: NotificationRow[] = [
      { kind: 'ticket', ref_id: 't1', client_id: 'c1', channel_id: '19:chan', activity_id: 'act-9', sent_at: '', action: null, action_by: null, action_at: null },
    ]
    for (const email of ['asha@x.in', 'ravi@x.in']) {
      for (const action of ['start', 'close', 'not_ticket'] as const) {
        for (const [kind, ref] of [['ticket', 't1'], ['reminder', R1], ['escalation', E1]] as const) {
          const s = setup({ email, rows })
          const r = await handleActivity(click({ action, ticketId: 't1', kind, ref }), s.deps)
          expect(body(r)).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: USE_SHADOW })
          await s.runDeferred()
          expect(s.data.ticketForUser).not.toHaveBeenCalled()
          expect(s.data.updateConversation).not.toHaveBeenCalled()
          expect(s.recorded).toHaveLength(0)
          expect(s.updated).toHaveLength(0)
          expect(s.sent).toHaveLength(0)
        }
      }
    }
  })

  it('start: an engineer is refused', async () => {
    const s = setup({ email: 'eng@x.in' })
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(body(r).value).toBe(REFUSAL)
  })

  it('close and not_ticket close the ticket and record on the clicked and ticket rows', async () => {
    for (const action of ['close', 'not_ticket'] as const) {
      const s = setup({ email: ADMIN })
      const r = await handleActivity(click({ action, ticketId: 't1', kind: 'escalation', ref: E1 }), s.deps)
      expect(s.data.updateConversation).toHaveBeenCalledWith(expect.objectContaining({ email: ADMIN }), 't1', { status: 'closed' })
      expect(body(r).type).toBe('application/vnd.microsoft.card.adaptive')
      const done = action === 'close' ? 'closed' : 'not_ticket'
      expect(s.recorded.map((x) => `${x.kind}:${x.ref}:${x.action}`)).toEqual([`escalation:${E1}:${done}`, `ticket:t1:${done}`])
    }
  })

  it('close: an engineer gets the friendly message, never the error', async () => {
    const s = setup({ email: 'eng@x.in' })
    const r = await handleActivity(click({ action: 'close', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(body(r)).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: REFUSAL })
    expect(s.recorded).toHaveLength(0)
  })

  it('close: another accountant gets the same answer for a real and a missing ticket (existence is not revealed)', async () => {
    const s = setup({ email: 'ravi@x.in' })
    expect(body(await handleActivity(click({ action: 'close', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)).value).toBe(USE_SHADOW)
    expect(body(await handleActivity(click({ action: 'close', ticketId: 'nope', kind: 'ticket', ref: 'nope' }), s.deps)).value).toBe(USE_SHADOW)
    expect(s.data.updateConversation).not.toHaveBeenCalled()
  })

  it('close: an admin pressing Close on a missing ticket gets the refusal and nothing is closed', async () => {
    const s = setup({ email: ADMIN })
    const r = await handleActivity(click({ action: 'close', ticketId: 'nope', kind: 'ticket', ref: 'nope' }), s.deps)
    expect(body(r).value).toBe(REFUSAL)
    expect(s.data.updateConversation).not.toHaveBeenCalled()
    expect(s.recorded).toHaveLength(0)
  })

  it('a closed ticket is not closed again, started or marked not a ticket (no second action recorded)', async () => {
    for (const action of ['close', 'not_ticket', 'start'] as const) {
      const s = setup({ email: ADMIN, ticketStatus: 'closed' })
      const r = await handleActivity(click({ action, ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
      expect(body(r).value).toBe(ALREADY_CLOSED)
      expect(s.data.updateConversation).not.toHaveBeenCalled()
      expect(s.recorded).toHaveLength(0)
    }
  })

  it('reassign to the accountant who already has the ticket is a no-op', async () => {
    const s = setup({ email: 'admin@x.in', map: emptyMap() })
    const r = await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-1' }), s.deps)
    expect(String(body(r).value)).toMatch(/already with Asha/)
    expect(s.data.reassignTicket).not.toHaveBeenCalled()
  })

  it('reassign: posts the ticket card to the new accountant 1:1 chat when they have one', async () => {
    const s = setup({ email: 'admin@x.in', map: emptyMap() })
    s.chats['ravi@x.in'] = { conversationId: 'a:ravi-1on1', serviceUrl: SVC, name: 'Ravi', at: '' }
    await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-2' }), s.deps)
    await s.runDeferred()
    expect(s.sent.map((x) => x.conversationId)).toEqual(['a:ravi-1on1'])
    // The new accountant works on it in Shadow: Open in Shadow only, no buttons.
    expect(cardText(s.sent[0].activity)).not.toContain('Action.Execute')
    expect(cardText(s.sent[0].activity)).toContain('Open in Shadow')
  })

  it('reassign: admin reassigns, records with a note and posts the ticket card to the new channel (fallback)', async () => {
    const map = emptyMap()
    map.accountants['va-2'] = { id: '19:ravi', name: 'Ravi tickets' }
    const s = setup({ email: 'admin@x.in', map, chats: { 'admin@x.in': { conversationId: 'a:1on1', serviceUrl: SVC, name: null, at: '' } } })
    const r = await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-2' }), s.deps)
    expect(s.data.reassignTicket).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }), 't1', 'va-2')
    expect(s.sent).toHaveLength(0) // posted after the invoke answer
    await s.runDeferred()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].conversationId).toBe('19:ravi')
    const posted = s.sent[0].activity.attachments?.[0].content
    expect(cardText(posted)).toContain('New ticket: Acme Traders')
    expect(cardText(posted)).not.toContain('Action.Execute')
    expect((posted?.actions as { type: string; title: string }[]).map((a) => [a.type, a.title])).toEqual([['Action.OpenUrl', 'Open in Shadow']])
    expect(cardText(body(r).value)).toContain('Reassigned to Ravi')
    expect(s.recorded.map((x) => `${x.kind}:${x.ref}:${x.action}`)).toEqual([`escalation:${E1}:reassigned`, 'ticket:t1:reassigned'])
  })

  it('reassign: says so in the note when the new accountant has not opened Shadow', async () => {
    const s = setup({ email: 'admin@x.in', map: emptyMap(), chats: {} })
    const r = await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-2' }), s.deps)
    await s.runDeferred()
    expect(s.sent).toHaveLength(0)
    expect(cardText(body(r).value)).toContain('have not opened the Shadow chat')
  })

  it('reassign: a senior accountant is told to use Shadow; a missing pick asks for one', async () => {
    const s = setup()
    const r = await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-2' }), s.deps)
    expect(body(r).value).toBe(USE_SHADOW)
    expect(s.data.reassignTicket).not.toHaveBeenCalled()
    expect(s.recorded).toHaveLength(0)
    const a = setup({ email: 'admin@x.in' })
    const r2 = await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: '' }), a.deps)
    expect(String(body(r2).value)).toMatch(/pick an accountant/i)
  })

  it('ping: goes to the accountant 1:1 chat, without an @mention', async () => {
    const s = setup({ email: 'admin@x.in', map: emptyMap() })
    s.chats['asha@x.in'] = { conversationId: 'a:asha-1on1', serviceUrl: SVC, name: 'Asha', at: '' }
    await handleActivity(click({ action: 'ping', ticketId: 't1', kind: 'escalation', ref: E1 }), s.deps)
    await s.runDeferred()
    expect(s.sent[0].conversationId).toBe('a:asha-1on1')
    expect(s.sent[0].activity.entities).toBeUndefined()
    expect(s.sent[0].activity.text).toMatch(/asked you to pick this up/)
    expect(s.sent[1].activity.text).toBe('Accountant pinged by Admin One')
  })

  it('ping: admin posts a reminder with an @mention to the linked channel (fallback) and records pinged on the escalation only', async () => {
    const map = emptyMap()
    map.accountants['va-1'] = { id: '19:asha', name: 'Asha tickets' }
    const s = setup({ email: 'admin@x.in', map, chats: { 'admin@x.in': { conversationId: 'a:1on1', serviceUrl: SVC, name: null, at: '' } } })
    const r = await handleActivity(click({ action: 'ping', ticketId: 't1', kind: 'escalation', ref: E1 }), s.deps)
    expect(s.recorded.map((x) => `${x.kind}:${x.ref}:${x.action}`)).toEqual([`escalation:${E1}:pinged`])
    expect(body(r).type).toBe('application/vnd.microsoft.card.adaptive')
    expect(s.sent).toHaveLength(0) // posted after the invoke answer
    await s.runDeferred()
    expect(s.sent).toHaveLength(2)
    const out = s.sent[0]
    expect(out.conversationId).toBe('19:asha')
    expect(out.activity.text).toBe('<at>Asha</at> please pick this up')
    expect(out.activity.entities).toEqual([{ type: 'mention', text: '<at>Asha</at>', mentioned: { id: '29:asha', name: 'Asha' } }])
    expect(out.activity.attachments).toHaveLength(1)
    expect(s.updated).toHaveLength(0)
  })

  it('ping: non-admin refused; no channel gives a friendly message', async () => {
    const s = setup({ email: 'eng@x.in' })
    expect(body(await handleActivity(click({ action: 'ping', ticketId: 't1', kind: 'escalation', ref: E1 }), s.deps)).value).toBe(REFUSAL)
    const a = setup({ email: 'admin@x.in', map: emptyMap(), chats: {} })
    const r = await handleActivity(click({ action: 'ping', ticketId: 't1', kind: 'escalation', ref: E1 }), a.deps)
    expect(body(r).value).toBe(NO_ACCOUNTANT_CHAT)
    expect(a.recorded).toHaveLength(0)
  })

  it('an unexpected data error becomes a friendly message without details', async () => {
    const s = setup({ email: ADMIN })
    s.data.updateConversation.mockRejectedValueOnce(new Error('updateConversation: connection refused at db.internal:5432'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await handleActivity(click({ action: 'close', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    err.mockRestore()
    expect(String(body(r).value)).not.toContain('5432')
    expect(String(body(r).value)).toMatch(/did not work/)
  })
})

// ---------------------------------------------------------------- commands

describe('channel commands', () => {
  it('help and an empty message send the help card', async () => {
    const s = setup()
    await handleActivity(base({ text: '<at>Shadow</at> HELP ' }), s.deps)
    await handleActivity(base({ text: '<at>Shadow</at>' }), s.deps)
    expect(s.sent).toHaveLength(2)
    for (const m of s.sent) expect(m.activity.attachments?.[0].contentType).toBe('application/vnd.microsoft.card.adaptive')
  })

  it('link <email> creates the map and links this channel (thread id stripped)', async () => {
    const s = setup({ email: 'admin@x.in' })
    await handleActivity(channelActivity('<at>Shadow</at> link asha@x.in'), s.deps)
    expect(s.getMap()).toEqual({
      serviceUrl: SVC,
      tenantId: TENANT,
      teamId: '19:team@thread.tacv2',
      accountants: { 'va-1': { id: '19:chan@thread.tacv2', name: 'Asha tickets' } },
      escalations: null,
    })
    expect(s.sent[0].conversationId).toBe('19:chan@thread.tacv2;messageid=123')
    expect(s.sent[0].activity.text).toMatch(/Asha/)
  })

  it('linking moves a channel: link escalations removes its accountant link', async () => {
    const s = setup({ email: 'eng@x.in' })
    await handleActivity(channelActivity('link asha@x.in'), s.deps)
    await handleActivity(channelActivity('link escalations'), s.deps)
    const m = s.getMap()!
    expect(m.accountants).toEqual({})
    expect(m.escalations).toEqual({ id: '19:chan@thread.tacv2', name: 'Asha tickets' })
  })

  it('unlink removes the channel everywhere; channels lists names', async () => {
    const map = emptyMap()
    map.accountants['va-2'] = { id: '19:other', name: 'Ravi tickets' }
    map.escalations = { id: '19:chan@thread.tacv2', name: 'Esc' }
    const s = setup({ email: 'admin@x.in', map })
    await handleActivity(channelActivity('channels'), s.deps)
    expect(s.sent[0].activity.text).toContain('Escalations: Esc')
    expect(s.sent[0].activity.text).toContain('Ravi: Ravi tickets')
    expect(s.sent[0].activity.text).toContain('Asha: not linked')
    await handleActivity(channelActivity('unlink'), s.deps)
    expect(s.getMap()!.escalations).toBeNull()
    expect(s.getMap()!.accountants['va-2']).toEqual({ id: '19:other', name: 'Ravi tickets' })
    await handleActivity(channelActivity('unlink'), s.deps)
    expect(s.sent[2].activity.text).toMatch(/not linked/)
  })

  it('unknown email is reported and nothing is saved', async () => {
    const s = setup({ email: 'admin@x.in' })
    await handleActivity(channelActivity('link nobody@x.in'), s.deps)
    expect(s.saved).toHaveLength(0)
    expect(s.sent[0].activity.text).toMatch(/No Senior Accountant/)
  })

  it('a senior accountant cannot link, and links only work in a team channel', async () => {
    const s = setup()
    await handleActivity(channelActivity('link escalations'), s.deps)
    expect(s.saved).toHaveLength(0)
    expect(s.sent[0].activity.text).toMatch(/Only an Admin or Engineer/)
    const a = setup({ email: 'admin@x.in' })
    await handleActivity(base({ text: 'link escalations' }), a.deps)
    expect(a.saved).toHaveLength(0)
    expect(a.sent[0].activity.text).toMatch(/team channel/)
  })
})

// ---------------------------------------------------------------- AI questions

describe('AI questions', () => {
  it('returns 200 at once, then answers in the same 1:1 chat with sources', async () => {
    const s = setup()
    const a = base({ text: '<at>Shadow</at>  What is pending for   Acme? ' })
    const r = await handleActivity(a, s.deps)
    expect(r).toEqual({ status: 200 })
    expect(s.sent).toHaveLength(0)
    expect(s.tasks).toHaveLength(1)
    await s.runDeferred()
    expect(s.ask).toHaveBeenCalledWith(expect.objectContaining({ email: 'asha@x.in' }), 'What is pending for Acme?', {
      history: [],
      teams: true,
    })
    expect(s.sent[0].conversationId).toBe('a:1on1')
    const text = s.sent[0].activity.text!
    expect(s.sent[0].activity.textFormat).toBe('markdown')
    expect(text).toContain('Acme filed GSTR-3B')
    expect(text).toContain('**Sources**')
    expect(text).toContain('1. [WhatsApp message, 20 Oct 10:15](https://shadow.example/clients/c1/timeline?m=9)')
    expect(text).toContain('2. [Return  PDF](https://sharepoint.example/doc%201.pdf)')
    expect(text).toContain('3. Meeting at 12:30')
  })

  it('caps the message at MAX_QUESTION characters and keeps line breaks', async () => {
    const s = setup()
    await handleActivity(base({ text: 'x'.repeat(MAX_QUESTION + 5000) }), s.deps)
    await s.runDeferred()
    expect((s.ask.mock.calls[0] as unknown[])[1]).toHaveLength(MAX_QUESTION)
    const t = setup()
    await handleActivity(base({ text: 'Ravi: hello<br>Asha:  hi&nbsp;there' }), t.deps)
    await t.runDeferred()
    expect((t.ask.mock.calls[0] as unknown[])[1]).toBe('Ravi: hello\nAsha: hi there')
  })

  it('remembers the chat: the next question gets the earlier turns, citation numbers removed', async () => {
    const s = setup()
    await handleActivity(base({ id: 'm1', text: 'What is pending for Acme?' }), s.deps)
    await s.runDeferred()
    await handleActivity(base({ id: 'm2', text: 'And for Beta?' }), s.deps)
    await s.runDeferred()
    expect((s.ask.mock.calls[1] as unknown[])[2]).toEqual({
      history: [
        { role: 'user', text: 'What is pending for Acme?' },
        { role: 'assistant', text: 'Acme filed GSTR-3B on 20 Oct .' },
      ],
      teams: true,
    })
  })

  it('new chat forgets the earlier turns without asking the AI', async () => {
    const s = setup()
    await handleActivity(base({ id: 'm1', text: 'What is pending for Acme?' }), s.deps)
    await s.runDeferred()
    await handleActivity(base({ id: 'm2', text: 'New chat' }), s.deps)
    expect(s.sent.at(-1)?.activity.text).toBe(NEW_CHAT_DONE)
    expect(s.chatRows.filter((r) => r.kind !== 'pending_save')).toHaveLength(0)
    expect(s.ask).toHaveBeenCalledTimes(1)
  })

  it('masks credentials before storing memory or asking the AI, and keeps the user turn when the AI fails', async () => {
    const s = setup()
    s.ask.mockRejectedValueOnce(new Error('timeout'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleActivity(base({ text: 'GST portal password: Abc@123 for Acme' }), s.deps)
    await s.runDeferred()
    err.mockRestore()
    const asked = (s.ask.mock.calls[0] as unknown[])[1] as string
    expect(asked).not.toContain('Abc@123')
    expect(s.chatRows.map((r) => r.kind)).toEqual(['user'])
    expect(s.chatRows[0].content).not.toContain('Abc@123')
    expect(s.sent[0].activity.text).toBe(AI_FAILED)
  })

  it('answers without memory when memory cannot be read', async () => {
    const s = setup()
    vi.mocked(s.chat.recentTurns).mockRejectedValueOnce(new Error('db down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleActivity(base({ text: 'hello' }), s.deps)
    await s.runDeferred()
    err.mockRestore()
    expect(s.sent[0].activity.text).toContain('Acme filed GSTR-3B')
  })

  it('sends a sorry message when the AI fails', async () => {
    const s = setup()
    s.ask.mockRejectedValueOnce(new Error('OpenRouter 500'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleActivity(base({ text: 'anything new?' }), s.deps)
    await s.runDeferred()
    err.mockRestore()
    expect(s.sent[0].activity.text).toBe(AI_FAILED)
  })
})

// ---------------------------------------------------------------- 1:1 chat registration

describe('remembering each person 1:1 chat', () => {
  it('the first message saves the chat and says what the person will get, before answering', async () => {
    const s = setup({ chats: {} })
    await handleActivity(base({ text: 'hi' }), s.deps)
    expect(s.store.savePersonalChat).toHaveBeenCalledWith('asha@x.in', expect.objectContaining({ conversationId: 'a:1on1', serviceUrl: SVC, name: 'Asha' }))
    expect(s.sent[0].activity.text).toBe(setupLine(users['asha@x.in']))
    expect(s.sent[0].activity.text).toMatch(/tickets, reminders, client files and follow-ups/)
    await s.runDeferred()
    expect(s.sent[1].activity.text).toContain('Acme filed GSTR-3B')
  })

  it('an Admin is told they get escalations', () => {
    expect(setupLine(users['admin@x.in'])).toMatch(/escalations/)
  })

  it('a known chat is not saved again and gets no setup line; a changed chat is saved again quietly', async () => {
    const s = setup()
    await handleActivity(base({ id: 'm1', text: 'hi' }), s.deps)
    expect(s.store.savePersonalChat).not.toHaveBeenCalled()
    expect(s.sent).toHaveLength(0)

    const moved = setup({ chats: { 'asha@x.in': { conversationId: 'a:old', serviceUrl: SVC, name: 'Asha', at: '' } } })
    await handleActivity(base({ id: 'm2', text: 'hi' }), moved.deps)
    expect(moved.store.savePersonalChat).toHaveBeenCalledWith('asha@x.in', expect.objectContaining({ conversationId: 'a:1on1' }))
    expect(moved.sent).toHaveLength(0)
  })

  it('a channel message never saves a chat', async () => {
    const s = setup({ chats: {}, email: 'admin@x.in' })
    await handleActivity(channelActivity('channels'), s.deps)
    expect(s.store.savePersonalChat).not.toHaveBeenCalled()
  })

  it('installing Shadow in a 1:1 chat saves it and sends the help card and the setup line', async () => {
    const s = setup({ chats: {} })
    await handleActivity(base({ type: 'conversationUpdate', membersAdded: [{ id: '28:bot' }] }), s.deps)
    expect(s.store.savePersonalChat).toHaveBeenCalledWith('asha@x.in', expect.objectContaining({ conversationId: 'a:1on1' }))
    expect(s.sent).toHaveLength(2)
    expect(s.sent[0].activity.attachments).toHaveLength(1)
    expect(s.sent[1].activity.text).toBe(setupLine(users['asha@x.in']))
  })

  it('a save lost to another person registering at the same moment is written again', async () => {
    const s = setup({ chats: {} })
    let calls = 0
    vi.mocked(s.store.savePersonalChat).mockImplementation(async (email, chat) => {
      calls++
      if (calls > 1) s.chats[email] = { ...chat } // the first write is overwritten by someone else
    })
    await handleActivity(base({ id: 'm1', text: 'hi' }), s.deps)
    expect(s.store.savePersonalChat).toHaveBeenCalledTimes(2)
    expect(s.chats['asha@x.in']?.conversationId).toBe('a:1on1')
  })

  it('a save failure is logged and the question is still answered', async () => {
    const s = setup({ chats: {} })
    vi.mocked(s.store.savePersonalChat).mockRejectedValueOnce(new Error('db down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleActivity(base({ text: 'hi' }), s.deps)
    await s.runDeferred()
    err.mockRestore()
    expect(s.sent.map((x) => x.activity.text)).toEqual([expect.stringContaining('Acme filed GSTR-3B')])
  })
})

// ---------------------------------------------------------------- save to client

describe('saving a transcript', () => {
  const transcript = 'Ravi: We will pay GST on Friday.\nAsha: Noted, I will send the challan.'
  const proposal = {
    clientId: 'c1',
    clientName: 'Acme Traders',
    title: 'Call with Ravi',
    meetingDate: '2026-11-18',
    source: 'this_message' as const,
    startsWith: 'Ravi: We will pay',
  }

  async function proposed(o: Parameters<typeof setup>[0] = {}) {
    const s = setup(o)
    s.ask.mockResolvedValueOnce({ text: 'Press Save on the card to store it for Acme Traders.', citations: [], save: proposal })
    await handleActivity(base({ text: `Please save this for Acme<br>${transcript.replace('\n', '<br>')}` }), s.deps)
    await s.runDeferred()
    const card = s.sent[1]?.activity.attachments?.[0].content
    const save = (card?.actions as { data: { action: string; pendingId: string } }[] | undefined)?.find((a) => a.data.action === 'save')
    return { s, card, pendingId: save?.data.pendingId ?? '' }
  }

  function click(action: 'save' | 'cancel', pendingId: string, id?: string): Activity {
    return base({ type: 'invoke', name: 'adaptiveCard/action', ...(id ? { id } : {}), value: { action: { type: 'Action.Execute', verb: 'save', data: { action, pendingId } } } })
  }

  it('shows a Save card with only the transcript (the request line is cut), and saves nothing yet', async () => {
    const { s, card, pendingId } = await proposed()
    expect(s.sent[0].activity.text).toContain('Press Save')
    expect(JSON.stringify(card)).toContain('Save to Acme Traders?')
    expect(pendingId).toBeTruthy()
    const pending = s.chatRows.find((r) => r.kind === 'pending_save')
    expect(pending?.content).toBe(transcript)
    expect(s.saveTranscript).not.toHaveBeenCalled()
  })

  it('Save stores it once for the client; a second click finds nothing', async () => {
    const { s, pendingId } = await proposed()
    const r = await handleActivity(click('save', pendingId, 'i1'), s.deps)
    expect(s.saveTranscript).toHaveBeenCalledWith(expect.objectContaining({ email: 'asha@x.in' }), {
      clientId: 'c1',
      title: 'Call with Ravi',
      meetingDate: '2026-11-18',
      transcript,
      now: NOW,
    })
    expect(JSON.stringify(r.body)).toContain('Saved to Acme Traders by Asha')
    const again = await handleActivity(click('save', pendingId, 'i2'), s.deps)
    expect(again.body).toMatchObject({ value: SAVE_GONE })
    expect(s.saveTranscript).toHaveBeenCalledTimes(1)
  })

  it('another person cannot press Save on my card', async () => {
    const { s, pendingId } = await proposed()
    vi.mocked(s.deps.connector.member).mockResolvedValue({ email: 'ravi@x.in', name: null, aadObjectId: null })
    resetBotState() // member cache
    const r = await handleActivity(click('save', pendingId), s.deps)
    expect(r.body).toMatchObject({ value: SAVE_GONE })
    expect(s.saveTranscript).not.toHaveBeenCalled()
    expect(s.chatRows.some((x) => x.kind === 'pending_save')).toBe(true)
  })

  it('Cancel removes the request without saving', async () => {
    const { s, pendingId } = await proposed()
    const r = await handleActivity(click('cancel', pendingId), s.deps)
    expect(JSON.stringify(r.body)).toContain('Cancelled by Asha')
    expect(s.saveTranscript).not.toHaveBeenCalled()
    expect(s.chatRows.some((x) => x.kind === 'pending_save')).toBe(false)
  })

  it('refuses a client outside the user scope, and keeps a retry card when the save fails', async () => {
    const { s, pendingId } = await proposed()
    s.saveTranscript.mockRejectedValueOnce(new ForbiddenError())
    expect((await handleActivity(click('save', pendingId), s.deps)).body).toMatchObject({ value: REFUSAL })

    const t = await proposed()
    t.s.saveTranscript.mockRejectedValueOnce(new Error('db down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await handleActivity(click('save', t.pendingId), t.s.deps)
    err.mockRestore()
    expect(JSON.stringify(r.body)).toContain('Save to Acme Traders?')
    expect(t.s.chatRows.filter((x) => x.kind === 'pending_save')).toHaveLength(1)
  })

  it('an old card has expired', async () => {
    let now = NOW
    const { s, pendingId } = await proposed({ now: () => now })
    now = new Date(NOW.getTime() + 25 * 60 * 60_000)
    expect((await handleActivity(click('save', pendingId), s.deps)).body).toMatchObject({ value: SAVE_EXPIRED })
    expect(s.saveTranscript).not.toHaveBeenCalled()
  })

  it('says so when there is nothing to save', async () => {
    const s = setup()
    s.ask.mockResolvedValueOnce({ text: 'Okay.', citations: [], save: { ...proposal, startsWith: null } })
    await handleActivity(base({ text: 'save it' }), s.deps)
    await s.runDeferred()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].activity.text).toContain(NOTHING_TO_SAVE)
  })

  it('rejects a malformed save click', async () => {
    const s = setup()
    const r = await handleActivity(base({ type: 'invoke', name: 'adaptiveCard/action', value: { action: { type: 'Action.Execute', verb: 'save', data: { action: 'drop' } } } }), s.deps)
    expect(r.body).toMatchObject({ statusCode: 400 })
  })
})

// ---------------------------------------------------------------- install and helpers

describe('closing a ticket by typing', () => {
  async function typed(o: Parameters<typeof setup>[0] = {}, closes = ['t1']) {
    const s = setup(o)
    s.ask.mockResolvedValueOnce({ text: 'Press Close on the card to close it.', citations: [], closes })
    await handleActivity(base({ text: 'close the GST ticket for Acme' }), s.deps)
    await s.runDeferred()
    return s
  }

  it('a senior accountant gets the ticket with only Open in Shadow (close it in Shadow), and nothing is closed', async () => {
    const s = await typed()
    expect(s.sent[0].activity.text).toContain('Press Close')
    const card = s.sent[1]?.activity.attachments?.[0].content
    expect(cardText(card)).toContain('Close in Shadow: Acme Traders')
    expect(cardText(card)).toContain('Open the ticket in Shadow and close it there.')
    expect(cardText(card)).toContain('GST query')
    expect(cardText(card)).not.toContain('Close this ticket?')
    expect(cardText(card)).not.toContain('Action.Execute')
    const actions = (card?.actions ?? []) as { type: string; title: string }[]
    expect(actions.map((a) => [a.type, a.title])).toEqual([['Action.OpenUrl', 'Open in Shadow']])
    expect(s.data.updateConversation).not.toHaveBeenCalled()
  })

  it('an admin gets a Close card for the ticket and nothing is closed until it is pressed', async () => {
    const s = await typed({ email: ADMIN })
    const card = s.sent[1]?.activity.attachments?.[0].content
    expect(cardText(card)).toContain('Close this ticket? Acme Traders')
    expect(cardText(card)).toContain('GST query')
    const actions = (card?.actions ?? []) as { type: string; data?: Record<string, unknown> }[]
    expect(actions.filter((a) => a.type === 'Action.Execute').map((a) => a.data)).toEqual([
      { action: 'close', ticketId: 't1', kind: 'ticket', ref: 't1' },
    ])
    expect(s.data.updateConversation).not.toHaveBeenCalled()
  })

  it('an admin pressing Close on that card closes the ticket through the normal card action', async () => {
    const s = await typed({ email: ADMIN })
    const r = await handleActivity(click({ action: 'close', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(s.data.updateConversation).toHaveBeenCalledWith(expect.objectContaining({ email: ADMIN }), 't1', { status: 'closed' })
    expect(body(r).type).toBe('application/vnd.microsoft.card.adaptive')
    expect(s.recorded.map((x) => `${x.kind}:${x.ref}:${x.action}`)).toEqual(['ticket:t1:closed'])
  })

  it('a senior accountant pressing Close on an older Close card is told to use Shadow; nothing is closed', async () => {
    const s = await typed()
    const r = await handleActivity(click({ action: 'close', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(body(r).value).toBe(USE_SHADOW)
    expect(s.data.updateConversation).not.toHaveBeenCalled()
    expect(s.recorded).toHaveLength(0)
  })

  it('no card for a ticket the user may not see, an already closed one or an unknown id: a line instead', async () => {
    const other = await typed({ email: 'ravi@x.in' })
    expect(other.sent).toHaveLength(1)
    expect(other.sent[0].activity.text).toContain(REFUSAL)

    const closed = await typed({ ticketStatus: 'closed' })
    expect(closed.sent).toHaveLength(1)
    expect(closed.sent[0].activity.text).toContain(ALREADY_CLOSED)

    const unknown = await typed({}, ['nope'])
    expect(unknown.sent).toHaveLength(1)
    expect(unknown.sent[0].activity.text).toContain(REFUSAL)
  })

  it('an engineer never gets a Close card, even if the AI proposed one', async () => {
    const s = await typed({ email: 'eng@x.in' })
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].activity.text).toContain(REFUSAL)
    expect(s.data.ticketForUser).not.toHaveBeenCalled()
  })

  it('a save and a close in one answer: the answer, then the Close card, then the Save card', async () => {
    const s = setup()
    s.ask.mockResolvedValueOnce({
      text: 'Press the buttons below.',
      citations: [],
      closes: ['t1'],
      save: { clientId: 'c1', clientName: 'Acme Traders', title: 'Call', meetingDate: null, source: 'this_message', startsWith: null },
    })
    await handleActivity(base({ text: 'save this for Acme and close the GST ticket<br>Ravi: we will pay on Monday' }), s.deps)
    await s.runDeferred()
    expect(s.sent).toHaveLength(3)
    expect(cardText(s.sent[1].activity.attachments?.[0].content)).toContain('Close in Shadow: Acme Traders')
    expect(cardText(s.sent[2].activity.attachments?.[0].content)).toContain('Save to Acme Traders?')
  })

  it('after Close is pressed the card reads "Ticket:", not "New ticket:"', async () => {
    const s = await typed({ email: ADMIN })
    const r = await handleActivity(click({ action: 'close', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    const after = cardText(body(r).value)
    expect(after).toContain('Ticket: Acme Traders')
    expect(after).not.toContain('New ticket')
  })

  it('a failed lookup adds a friendly line and still sends the answer', async () => {
    const s = setup()
    s.data.ticketForUser.mockRejectedValueOnce(new Error('db down'))
    s.ask.mockResolvedValueOnce({ text: 'Press Close on the card.', citations: [], closes: ['t1'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleActivity(base({ text: 'close the GST ticket for Acme' }), s.deps)
    await s.runDeferred()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].activity.text).toContain('Press Close')
    expect(s.sent[0].activity.text).not.toContain('db down')
  })
})

describe('install and other activities', () => {
  it('welcomes with the help card when the bot is added', async () => {
    const s = setup()
    const r = await handleActivity(base({ type: 'conversationUpdate', membersAdded: [{ id: '28:bot' }] }), s.deps)
    expect(r.status).toBe(200)
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].activity.attachments).toHaveLength(1)
  })

  it('ignores other members joining and other activity types', async () => {
    const s = setup()
    await handleActivity(base({ type: 'conversationUpdate', membersAdded: [{ id: '29:someone' }] }), s.deps)
    expect((await handleActivity(base({ type: 'installationUpdate' }), s.deps)).status).toBe(200)
    expect((await handleActivity(base({ type: 'invoke', name: 'other' }), s.deps)).status).toBe(200)
    expect(s.sent).toHaveLength(0)
  })

  it('cleanText strips mentions and markup', () => {
    expect(cleanText('<at>Shadow Bot</at> link <a href="mailto:a@b.in">a@b.in</a>&nbsp;')).toBe('link a@b.in')
    expect(cleanText(undefined)).toBe('')
  })

  it('formatAnswer leaves an answer without citations unchanged', () => {
    expect(formatAnswer(SITE, { text: ' Not found in the records. ', citations: [] })).toBe('Not found in the records.')
  })
})

// ---------------------------------------------------------------- review fixes

const TEAM = '19:team@thread.tacv2'
const teamMap = (over: Partial<TeamsChannelMap> = {}): TeamsChannelMap => ({ ...emptyMap(), teamId: TEAM, ...over })

describe('privacy: AI questions only in a 1:1 chat', () => {
  it('a question in a channel or group chat gets the direct-chat reply and never reaches the AI', async () => {
    const s = setup()
    await handleActivity(channelActivity('<at>Shadow</at> what is pending for Acme?'), s.deps)
    await handleActivity(base({ text: 'what is pending?', conversation: { id: '19:group@thread.v2', tenantId: TENANT, conversationType: 'groupChat' } }), s.deps)
    await handleActivity(base({ text: 'what is pending?', conversation: { id: 'a:x', tenantId: TENANT } }), s.deps)
    await s.runDeferred()
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.sent.map((m) => m.activity.text)).toEqual([DIRECT_ONLY, DIRECT_ONLY, DIRECT_ONLY])
    expect(s.sent[0].conversationId).toBe('19:chan@thread.tacv2;messageid=123')
  })

  it('the app manifest offers the bot in team and personal scopes only (no group chats)', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'teams-app', 'manifest.template.json'), 'utf8')) as {
      bots: { scopes: string[]; commandLists: { scopes: string[] }[] }[]
    }
    expect(manifest.bots[0].scopes).toEqual(['team', 'personal'])
    for (const list of manifest.bots[0].commandLists) expect(list.scopes).not.toContain('groupchat')
  })

  it('commands still work in a channel', async () => {
    const s = setup({ email: 'admin@x.in' })
    await handleActivity(channelActivity('link escalations'), s.deps)
    expect(s.getMap()?.escalations).toEqual({ id: '19:chan@thread.tacv2', name: 'Asha tickets' })
    expect(s.ask).not.toHaveBeenCalled()
  })
})

describe('de-duplication and rate limit', () => {
  it('a repeated message activity id is ignored for 10 minutes', async () => {
    let now = NOW.getTime()
    const s = setup({ now: () => new Date(now) })
    const a = base({ id: 'm-1', text: 'anything new?' })
    expect(await handleActivity(a, s.deps)).toEqual({ status: 200 })
    expect(await handleActivity(a, s.deps)).toEqual({ status: 200 })
    await s.runDeferred()
    expect(s.ask).toHaveBeenCalledTimes(1)
    now += 10 * 60_000
    await handleActivity(a, s.deps)
    await s.runDeferred()
    expect(s.ask).toHaveBeenCalledTimes(2)
  })

  it('a repeated card click answers Already done and does not redo side effects', async () => {
    const map = emptyMap()
    map.accountants['va-2'] = { id: '19:ravi', name: 'Ravi tickets' }
    const s = setup({ email: 'admin@x.in', map })
    const a = { ...click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-2' }), id: 'inv-1' }
    const first = await handleActivity(a, s.deps)
    expect(body(first).type).toBe('application/vnd.microsoft.card.adaptive')
    const again = await handleActivity(a, s.deps)
    expect(body(again)).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: ALREADY_DONE })
    await s.runDeferred()
    expect(s.data.reassignTicket).toHaveBeenCalledTimes(1)
    expect(s.sent).toHaveLength(1)
    expect(s.recorded).toHaveLength(2)
  })

  it('an activity whose handling throws can be retried', async () => {
    const s = setup()
    vi.mocked(s.deps.connector.send).mockRejectedValueOnce(new Error('send down'))
    const a = base({ id: 'm-2', text: 'help' })
    await expect(handleActivity(a, s.deps)).rejects.toThrow('send down')
    await handleActivity(a, s.deps)
    expect(s.sent).toHaveLength(1)
  })

  it('allows 10 AI questions per email in 10 minutes, then asks the user to wait', async () => {
    let now = NOW.getTime()
    const s = setup({ now: () => new Date(now) })
    for (let i = 0; i < MAX_QUESTIONS; i++) await handleActivity(base({ text: `question ${i}` }), s.deps)
    await handleActivity(base({ text: 'one more' }), s.deps)
    await s.runDeferred()
    expect(s.ask).toHaveBeenCalledTimes(MAX_QUESTIONS)
    expect(s.sent.filter((m) => m.activity.text === TOO_MANY)).toHaveLength(1)

    // Another user is not affected (member lookups are per Teams user).
    const other = setup({ email: 'ravi@x.in', now: () => new Date(now), keepState: true })
    await handleActivity(base({ text: 'mine?', from: { id: '29:ravi', aadObjectId: 'aad-ravi' } }), other.deps)
    await other.runDeferred()
    expect(other.ask).toHaveBeenCalledTimes(1)

    now += 10 * 60_000
    await handleActivity(base({ text: 'later' }), s.deps)
    await s.runDeferred()
    expect(s.ask).toHaveBeenCalledTimes(MAX_QUESTIONS + 1)
  })
})

describe('identity speed: member lookups are cached', () => {
  it('reuses a member per serviceUrl and aadObjectId (or from.id) for 10 minutes; failures are not cached', async () => {
    let now = NOW.getTime()
    const s = setup({ now: () => new Date(now) })
    await handleActivity(base({ text: 'help' }), s.deps)
    await handleActivity(base({ text: 'help' }), s.deps)
    expect(s.deps.connector.member).toHaveBeenCalledTimes(1)
    await handleActivity(base({ text: 'help', from: { id: '29:user', aadObjectId: 'aad-1' } }), s.deps)
    await handleActivity(base({ text: 'help', from: { id: '29:other-id', aadObjectId: 'aad-1' } }), s.deps)
    expect(s.deps.connector.member).toHaveBeenCalledTimes(2)
    now += 10 * 60_000
    await handleActivity(base({ text: 'help' }), s.deps)
    expect(s.deps.connector.member).toHaveBeenCalledTimes(3)

    const f = setup()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(f.deps.connector.member).mockRejectedValueOnce(new Error('roster down'))
    await handleActivity(base({ text: 'help' }), f.deps)
    await handleActivity(base({ text: 'help' }), f.deps)
    err.mockRestore()
    expect(f.deps.connector.member).toHaveBeenCalledTimes(2)
    expect(f.sent[1].activity.attachments).toHaveLength(1)
  })
})

describe('invoke budget: posts run after the answer', () => {
  it('close answers with the card before the stored copy is updated; a failing reassign post is only logged', async () => {
    const s = setup({
      email: ADMIN,
      rows: [{ kind: 'ticket', ref_id: 't1', client_id: 'c1', channel_id: '19:chan', activity_id: 'act-9', sent_at: '', action: null, action_by: null, action_at: null }],
    })
    const r = await handleActivity(click({ action: 'close', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(s.data.updateConversation).toHaveBeenCalled()
    expect(s.recorded).toHaveLength(1)
    expect(body(r).type).toBe('application/vnd.microsoft.card.adaptive')
    expect(s.updated).toHaveLength(0)
    await s.runDeferred()
    expect(s.updated).toHaveLength(1)

    const map = emptyMap()
    map.accountants['va-2'] = { id: '19:ravi', name: 'Ravi tickets' }
    const a = setup({ email: 'admin@x.in', map })
    vi.mocked(a.deps.connector.send).mockRejectedValueOnce(new Error('post failed'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-2' }), a.deps)
    await expect(a.runDeferred()).resolves.toBeUndefined()
    expect(err).toHaveBeenCalledWith('[teams-bot] reassign post failed:', 'post failed')
    err.mockRestore()
  })
})

describe('card data is bound to its ticket', () => {
  it('rejects a ref that does not belong to the ticket', async () => {
    const s = setup()
    for (const ref of ['t2@2026-11-18T05:00:00.000Z', 't10', 't1x@1', 'e1']) {
      const r = await handleActivity(click({ action: 'close', ticketId: 't1', kind: 'escalation', ref }), s.deps)
      expect(body(r)).toEqual({ statusCode: 400, type: 'application/vnd.microsoft.error', value: { code: 'BadRequest', message: INVALID_CARD } })
    }
    expect(s.data.updateConversation).not.toHaveBeenCalled()
    expect(s.recorded).toHaveLength(0)
  })
})

describe('ping', () => {
  it('posts a read-only reminder (Open in Shadow only) to the accountant, keeps the escalation buttons and replies with a note', async () => {
    const map = emptyMap()
    map.accountants['va-1'] = { id: '19:asha', name: 'Asha tickets' }
    const s = setup({ email: 'admin@x.in', map })
    const r = await handleActivity(click({ action: 'ping', ticketId: 't1', kind: 'escalation', ref: E1 }), s.deps)
    const card = cardText(body(r).value)
    expect(card).toContain('Action.Execute')
    expect(card).toContain('"action":"reassign"')
    expect(card).toContain('"action":"ping"')
    expect(card).not.toContain('Pinged')
    await s.runDeferred()
    const reminder = s.sent[0].activity.attachments?.[0].content
    expect(s.sent[0].activity.text).toBe('An Admin asked you to pick this up.') // Asha's own 1:1 chat
    expect(cardText(reminder)).toContain('Client waiting')
    expect(cardText(reminder)).not.toContain('Action.Execute')
    expect(cardText(reminder)).not.toContain('#ping')
    expect((reminder?.actions as { type: string; title: string }[]).map((a) => [a.type, a.title])).toEqual([['Action.OpenUrl', 'Open in Shadow']])
    expect(s.sent[1]).toMatchObject({ conversationId: 'a:1on1', activity: { text: 'Accountant pinged by Admin One' } })
  })

  it('a click on an older ping reminder (by an admin) is not recorded on the real reminder row', async () => {
    const s = setup({ email: ADMIN })
    await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'reminder', ref: `${R1}#ping` }), s.deps)
    expect(s.recorded.map((x) => `${x.kind}:${x.ref}`)).toEqual([`reminder:${R1}#ping`, 'ticket:t1'])
  })

  it('a failed ping post tells the admin', async () => {
    const map = emptyMap()
    map.accountants['va-1'] = { id: '19:asha', name: 'Asha tickets' }
    const s = setup({ email: 'admin@x.in', map })
    vi.mocked(s.deps.connector.send).mockRejectedValueOnce(new Error('403'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleActivity(click({ action: 'ping', ticketId: 't1', kind: 'escalation', ref: E1 }), s.deps)
    await s.runDeferred()
    expect(err).toHaveBeenCalledWith('[teams-bot] ping post failed:', '403')
    err.mockRestore()
    expect(s.sent.at(-1)?.activity.text).toBe(PING_FAILED)
  })
})

describe('team binding', () => {
  it('refuses link and unlink from another team, but channels still answers', async () => {
    const map = teamMap({ teamId: '19:other-team@thread.tacv2', escalations: { id: '19:esc', name: 'Esc' } })
    const s = setup({ email: 'admin@x.in', map })
    await handleActivity(channelActivity('link asha@x.in'), s.deps)
    await handleActivity(channelActivity('link escalations'), s.deps)
    await handleActivity(channelActivity('unlink'), s.deps)
    await handleActivity(channelActivity('channels'), s.deps)
    expect(s.saved).toHaveLength(0)
    expect(s.sent.slice(0, 3).map((m) => m.activity.text)).toEqual([OTHER_TEAM, OTHER_TEAM, OTHER_TEAM])
    expect(s.sent[3].activity.text).toContain('Escalations: Esc')
  })

  it('updates the stored serviceUrl when the linked team arrives on a new one', async () => {
    const s = setup({ map: teamMap({ serviceUrl: 'https://smba.trafficmanager.net/old/' }) })
    await handleActivity(channelActivity('help'), s.deps)
    expect(s.saved).toHaveLength(0) // after the response
    await s.runDeferred()
    expect(s.getMap()?.serviceUrl).toBe(SVC)

    const other = setup({ map: teamMap({ teamId: '19:other-team@thread.tacv2', serviceUrl: 'https://old/' }) })
    await handleActivity(channelActivity('help'), other.deps)
    await other.runDeferred()
    expect(other.saved).toHaveLength(0)

    const same = setup({ map: teamMap() })
    await handleActivity(channelActivity('help'), same.deps)
    await same.runDeferred()
    expect(same.saved).toHaveLength(0)
  })

  it('unlinking the last channel clears the team so Shadow can move to another team', async () => {
    const s = setup({ email: 'admin@x.in', map: teamMap({ accountants: { 'va-1': { id: '19:chan@thread.tacv2', name: 'Asha tickets' } } }) })
    await handleActivity(channelActivity('unlink'), s.deps)
    expect(s.getMap()).toMatchObject({ teamId: null, accountants: {}, escalations: null })

    const kept = setup({
      email: 'admin@x.in',
      map: teamMap({ accountants: { 'va-1': { id: '19:chan@thread.tacv2', name: 'A' } }, escalations: { id: '19:esc', name: 'Esc' } }),
    })
    await handleActivity(channelActivity('unlink'), kept.deps)
    expect(kept.getMap()?.teamId).toBe(TEAM)
  })
})

describe('guests', () => {
  it('a guest (#EXT#) member is not set up and is never resolved', async () => {
    const s = setup({ email: 'asha_x.in#ext#@tenant.onmicrosoft.com' })
    await handleActivity(base({ text: 'what is pending?' }), s.deps)
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(s.sent[0].activity.text).toBe(NOT_SET_UP)
    expect(body(r).value).toBe(NOT_SET_UP)
    expect(s.deps.resolveUser).not.toHaveBeenCalled()
    expect(s.ask).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- follow-up card clicks

describe('follow-up card clicks', () => {
  const fuClick = (data: Record<string, unknown>, id?: string): Activity => ({
    ...base({ type: 'invoke', name: 'adaptiveCard/action', value: { action: { type: 'Action.Execute', verb: 'followup', data } } }),
    ...(id ? { id } : {}),
  })
  const DUE = followUpRef('f1', 'due')
  const MISSED = followUpRef('f1', 'missed')

  it('a senior accountant (own client or another) clicking done, cancel or extend is told to use Shadow; nothing changes', async () => {
    const rows: NotificationRow[] = [
      { kind: 'escalation', ref_id: MISSED, client_id: 'c1', channel_id: '19:esc', activity_id: 'act-7', sent_at: '', action: null, action_by: null, action_at: null },
    ]
    for (const email of ['asha@x.in', 'ravi@x.in']) {
      for (const action of ['done', 'cancel', 'extend'] as const) {
        for (const [kind, ref] of [['reminder', DUE], ['escalation', MISSED]] as const) {
          const s = setup({ email, rows })
          const r = await handleActivity(fuClick({ action, followUpId: 'f1', kind, ref }), s.deps)
          expect(body(r)).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: USE_SHADOW })
          await s.runDeferred()
          expect(s.followUps.action).not.toHaveBeenCalled()
          expect(s.recorded).toHaveLength(0)
          expect(s.updated).toHaveLength(0)
          expect(s.sent).toHaveLength(0)
        }
      }
    }
  })

  it('done: calls followUpAction, answers the handled card, records nothing in teams_notifications', async () => {
    const s = setup({ email: ADMIN })
    const r = await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), s.deps)
    expect(s.followUps.action).toHaveBeenCalledWith(expect.objectContaining({ email: ADMIN }), 'f1', 'done', NOW)
    expect(body(r).type).toBe('application/vnd.microsoft.card.adaptive')
    const text = cardText(body(r).value)
    expect(text).toContain('Promise due today: Acme Traders')
    expect(text).toContain('Marked done by Admin One')
    expect(text).not.toContain('Action.Execute')
    expect(s.recorded).toHaveLength(0)
  })

  it('cancel on a repeat ask shows Marked not a repeat; the heading follows the ref', async () => {
    const s = setup({ email: ADMIN })
    vi.mocked(s.followUps.action).mockResolvedValueOnce({ ...fuView, kind: 'repeat_ask', status: 'cancelled', dueAt: null })
    const r = await handleActivity(fuClick({ action: 'cancel', followUpId: 'f1', kind: 'escalation', ref: followUpRef('f1', 'repeat') }), s.deps)
    const text = cardText(body(r).value)
    expect(s.followUps.action).toHaveBeenCalledWith(expect.anything(), 'f1', 'cancel', NOW)
    expect(text).toContain('Client asked again: Acme Traders')
    expect(text).toContain('Marked not a repeat by Admin One')
  })

  it('extend: the card shows the new due date', async () => {
    const s = setup({ email: ADMIN })
    const r = await handleActivity(fuClick({ action: 'extend', followUpId: 'f1', kind: 'escalation', ref: MISSED }), s.deps)
    const text = cardText(body(r).value)
    expect(text).toContain('Promise missed: Acme Traders')
    expect(text).toContain('Extended by 1 day by Admin One')
    expect(text).toContain('New due date: 19 Nov, 6:00 pm')
  })

  it('refreshes the stored card copy after the answer when it has an activity id', async () => {
    const s = setup({
      email: ADMIN,
      rows: [
        { kind: 'escalation', ref_id: MISSED, client_id: 'c1', channel_id: '19:esc', activity_id: 'act-7', sent_at: '', action: null, action_by: null, action_at: null },
      ],
    })
    await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'escalation', ref: MISSED }), s.deps)
    expect(s.updated).toHaveLength(0)
    await s.runDeferred()
    expect(s.updated).toHaveLength(1)
    expect(s.updated[0]).toMatchObject({ conversationId: '19:esc', activityId: 'act-7' })
    expect(cardText(s.updated[0].activity)).toContain('Marked done by Admin One')

    const none = setup({ email: ADMIN })
    await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), none.deps)
    await none.runDeferred()
    expect(none.updated).toHaveLength(0)
  })

  it('Forbidden (engineer, an out-of-scope admin call, viewing as) gets the refusal', async () => {
    const e = setup({ email: 'eng@x.in' })
    const r = await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), e.deps)
    expect(body(r)).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: REFUSAL })
    const f = setup({ email: ADMIN })
    vi.mocked(f.followUps.action).mockRejectedValueOnce(new ForbiddenError())
    expect(body(await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), f.deps)).value).toBe(REFUSAL)
    const v = setup({ email: ADMIN })
    vi.mocked(v.followUps.action).mockRejectedValueOnce(new ViewAsReadOnlyError())
    expect(body(await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), v.deps)).value).toBe(REFUSAL)
  })

  it('closed, not found and extend of a repeat ask get friendly messages; other errors no detail', async () => {
    const cases: [Error, string][] = [
      [new Error('This follow-up is already closed.'), FOLLOW_UP_CLOSED],
      [new Error('Follow-up not found.'), FOLLOW_UP_NOT_FOUND],
      [new Error('Only promises and document requests can be extended.'), FOLLOW_UP_NO_EXTEND],
    ]
    for (const [e, msg] of cases) {
      const s = setup({ email: ADMIN })
      vi.mocked(s.followUps.action).mockRejectedValueOnce(e)
      const r = await handleActivity(fuClick({ action: 'extend', followUpId: 'f1', kind: 'reminder', ref: DUE }), s.deps)
      expect(body(r).value).toBe(msg)
    }
    const s = setup({ email: ADMIN })
    vi.mocked(s.followUps.action).mockRejectedValueOnce(new Error('update follow_ups: connection refused at db.internal:5432'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), s.deps)
    err.mockRestore()
    expect(String(body(r).value)).not.toContain('5432')
    expect(String(body(r).value)).toMatch(/did not work/)
  })

  it('an unknown user is not set up and nothing is changed', async () => {
    const s = setup({ email: 'stranger@x.in' })
    const r = await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), s.deps)
    expect(body(r).value).toBe(NOT_SET_UP)
    expect(s.followUps.action).not.toHaveBeenCalled()
  })

  it('a duplicate activity id answers Already done and acts once', async () => {
    const s = setup({ email: ADMIN })
    const a = fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }, 'inv-fu-1')
    expect(body(await handleActivity(a, s.deps)).type).toBe('application/vnd.microsoft.card.adaptive')
    expect(body(await handleActivity(a, s.deps))).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: ALREADY_DONE })
    expect(s.followUps.action).toHaveBeenCalledTimes(1)
  })

  it('invalid data or a ref of another follow-up is a BadRequest', async () => {
    const s = setup()
    for (const data of [
      { action: 'done', followUpId: 'f1', kind: 'reminder', ref: followUpRef('f2', 'due') },
      { action: 'done', followUpId: 'f1', kind: 'reminder', ref: 'fu:f1:soon:0' },
      { action: 'close', followUpId: 'f1', kind: 'reminder', ref: DUE },
      { action: 'done', ticketId: 't1', kind: 'ticket', ref: 't1' },
    ]) {
      const r = await handleActivity(fuClick(data), s.deps)
      expect(body(r)).toEqual({ statusCode: 400, type: 'application/vnd.microsoft.error', value: { code: 'BadRequest', message: INVALID_CARD } })
    }
    expect(s.followUps.action).not.toHaveBeenCalled()
  })

  it('ticket cards still go the ticket way', async () => {
    const s = setup({ email: ADMIN })
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(cardText(body(r).value)).toContain('Started by Admin One')
    expect(s.followUps.action).not.toHaveBeenCalled()
  })
})
