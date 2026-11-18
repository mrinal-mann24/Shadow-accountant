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
  MAX_QUESTIONS,
  NOT_SET_UP,
  OTHER_TEAM,
  PING_FAILED,
  REFUSAL,
  resetBotState,
  TOO_MANY,
  type BotDeps,
} from './bot'
import type {
  Activity,
  NotificationRow,
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
  } = {},
) {
  if (!o.keepState) resetBotState()
  const sent: Sent[] = []
  const updated: { conversationId: string; activityId: string; activity: OutgoingActivity }[] = []
  const tasks: (() => Promise<void>)[] = []
  const recorded: { kind: string; ref: string; action: string; by: string; at: string }[] = []
  let map: TeamsChannelMap | null = o.map === undefined ? null : o.map
  const saved: TeamsChannelMap[] = []
  const rows = o.rows ?? []

  const store: TeamsStore = {
    channels: async () => (map ? structuredClone(map) : null),
    saveChannels: async (m) => {
      map = structuredClone(m)
      saved.push(structuredClone(m))
    },
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

  const ask = vi.fn(async () => ({
    text: 'Acme filed GSTR-3B on 20 Oct [1].',
    citations: [
      { n: 1, label: 'WhatsApp message, 20 Oct 10:15', link: '/clients/c1/timeline?m=9' },
      { n: 2, label: 'Return [PDF]', link: 'https://sharepoint.example/doc 1.pdf' },
      { n: 3, label: 'Meeting at 12:30' },
    ],
  }))

  const deps: BotDeps = {
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
  return { deps, sent, updated, tasks, runDeferred, recorded, saved, data, followUps, ask, getMap: () => map }
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

  it('start: own accountant records started and returns the handled card; updates the stored card', async () => {
    const s = setup({
      rows: [
        { kind: 'ticket', ref_id: 't1', client_id: 'c1', channel_id: '19:chan', activity_id: 'act-9', sent_at: '', action: null, action_by: null, action_at: null },
      ],
    })
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(body(r).statusCode).toBe(200)
    expect(body(r).type).toBe('application/vnd.microsoft.card.adaptive')
    expect(cardText(body(r).value)).toContain('Asha')
    expect(cardText(body(r).value)).not.toContain('Action.Execute')
    expect(s.recorded).toEqual([{ kind: 'ticket', ref: 't1', action: 'started', by: 'asha@x.in', at: NOW.toISOString() }])
    expect(s.updated).toHaveLength(0) // after the invoke answer
    await s.runDeferred()
    expect(s.updated).toHaveLength(1)
    expect(s.updated[0]).toMatchObject({ conversationId: '19:chan', activityId: 'act-9' })
  })

  it('start from a reminder also records on the ticket row; a failing card update is ignored', async () => {
    const s = setup({
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

  it('start: an accountant from another client gets the friendly refusal', async () => {
    const s = setup({ email: 'ravi@x.in' })
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(body(r)).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: REFUSAL })
    expect(s.recorded).toHaveLength(0)
  })

  it('start: an engineer is refused', async () => {
    const s = setup({ email: 'eng@x.in' })
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(body(r).value).toBe(REFUSAL)
  })

  it('close and not_ticket close the ticket and record on the clicked and ticket rows', async () => {
    for (const action of ['close', 'not_ticket'] as const) {
      const s = setup()
      const r = await handleActivity(click({ action, ticketId: 't1', kind: 'escalation', ref: E1 }), s.deps)
      expect(s.data.updateConversation).toHaveBeenCalledWith(expect.objectContaining({ email: 'asha@x.in' }), 't1', { status: 'closed' })
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

  it('close: another accountant and a missing ticket get the same refusal (existence is not revealed)', async () => {
    const s = setup({ email: 'ravi@x.in' })
    expect(body(await handleActivity(click({ action: 'close', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)).value).toBe(REFUSAL)
    const s2 = setup()
    const r = await handleActivity(click({ action: 'close', ticketId: 'nope', kind: 'ticket', ref: 'nope' }), s2.deps)
    expect(body(r).value).toBe(REFUSAL)
    expect(s2.data.updateConversation).not.toHaveBeenCalled()
  })

  it('a closed ticket is not closed again, started or marked not a ticket (no second action recorded)', async () => {
    for (const action of ['close', 'not_ticket', 'start'] as const) {
      const s = setup({ ticketStatus: 'closed' })
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

  it('reassign: admin reassigns, records with a note and posts the ticket card to the new channel', async () => {
    const map = emptyMap()
    map.accountants['va-2'] = { id: '19:ravi', name: 'Ravi tickets' }
    const s = setup({ email: 'admin@x.in', map })
    const r = await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-2' }), s.deps)
    expect(s.data.reassignTicket).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }), 't1', 'va-2')
    expect(s.sent).toHaveLength(0) // posted after the invoke answer
    await s.runDeferred()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].conversationId).toBe('19:ravi')
    expect(cardText(s.sent[0].activity)).toContain('Action.Execute')
    expect(cardText(body(r).value)).toContain('Reassigned to Ravi')
    expect(s.recorded.map((x) => `${x.kind}:${x.ref}:${x.action}`)).toEqual([`escalation:${E1}:reassigned`, 'ticket:t1:reassigned'])
  })

  it('reassign: no channel for the new accountant is mentioned in the note', async () => {
    const s = setup({ email: 'admin@x.in', map: emptyMap() })
    const r = await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-2' }), s.deps)
    await s.runDeferred()
    expect(s.sent).toHaveLength(0)
    expect(cardText(body(r).value)).toContain('no Teams channel is linked')
  })

  it('reassign: a senior accountant cannot reassign; a missing pick asks for one', async () => {
    const s = setup()
    const r = await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: 'va-2' }), s.deps)
    expect(body(r).value).toBe(REFUSAL)
    expect(s.data.reassignTicket).not.toHaveBeenCalled()
    const a = setup({ email: 'admin@x.in' })
    const r2 = await handleActivity(click({ action: 'reassign', ticketId: 't1', kind: 'escalation', ref: E1, vaId: '' }), a.deps)
    expect(String(body(r2).value)).toMatch(/pick an accountant/i)
  })

  it('ping: admin posts a reminder with an @mention and records pinged on the escalation only', async () => {
    const map = emptyMap()
    map.accountants['va-1'] = { id: '19:asha', name: 'Asha tickets' }
    const s = setup({ email: 'admin@x.in', map })
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
    const a = setup({ email: 'admin@x.in', map: emptyMap() })
    const r = await handleActivity(click({ action: 'ping', ticketId: 't1', kind: 'escalation', ref: E1 }), a.deps)
    expect(String(body(r).value)).toMatch(/no teams channel/i)
    expect(a.recorded).toHaveLength(0)
  })

  it('an unexpected data error becomes a friendly message without details', async () => {
    const s = setup()
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
    expect(s.ask).toHaveBeenCalledWith(expect.objectContaining({ email: 'asha@x.in' }), 'What is pending for Acme?')
    expect(s.sent[0].conversationId).toBe('a:1on1')
    const text = s.sent[0].activity.text!
    expect(s.sent[0].activity.textFormat).toBe('markdown')
    expect(text).toContain('Acme filed GSTR-3B')
    expect(text).toContain('**Sources**')
    expect(text).toContain('1. [WhatsApp message, 20 Oct 10:15](https://shadow.example/clients/c1/timeline?m=9)')
    expect(text).toContain('2. [Return  PDF](https://sharepoint.example/doc%201.pdf)')
    expect(text).toContain('3. Meeting at 12:30')
  })

  it('caps the question at 1000 characters', async () => {
    const s = setup()
    await handleActivity(base({ text: 'x'.repeat(5000) }), s.deps)
    await s.runDeferred()
    expect((s.ask.mock.calls[0] as unknown[])[1]).toHaveLength(1000)
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

// ---------------------------------------------------------------- install and helpers

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
  it('posts the reminder with its own #ping ref, keeps the escalation buttons and replies with a note', async () => {
    const map = emptyMap()
    map.accountants['va-1'] = { id: '19:asha', name: 'Asha tickets' }
    const s = setup({ email: 'admin@x.in', map })
    const r = await handleActivity(click({ action: 'ping', ticketId: 't1', kind: 'escalation', ref: E1 }), s.deps)
    const card = cardText(body(r).value)
    expect(card).toContain('Action.Execute')
    expect(card).toContain('"action":"reassign"')
    expect(card).not.toContain('Pinged')
    await s.runDeferred()
    expect(cardText(s.sent[0].activity)).toContain(`"ref":"${E1}#ping"`)
    expect(s.sent[1]).toMatchObject({ conversationId: 'a:1on1', activity: { text: 'Accountant pinged by Admin One' } })
  })

  it('a click on the ping reminder is not recorded on the real reminder row', async () => {
    const s = setup()
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

  it('done: calls followUpAction, answers the handled card, records nothing in teams_notifications', async () => {
    const s = setup()
    const r = await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), s.deps)
    expect(s.followUps.action).toHaveBeenCalledWith(expect.objectContaining({ email: 'asha@x.in' }), 'f1', 'done', NOW)
    expect(body(r).type).toBe('application/vnd.microsoft.card.adaptive')
    const text = cardText(body(r).value)
    expect(text).toContain('Promise due today: Acme Traders')
    expect(text).toContain('Marked done by Asha')
    expect(text).not.toContain('Action.Execute')
    expect(s.recorded).toHaveLength(0)
  })

  it('cancel on a repeat ask shows Marked not a repeat; the heading follows the ref', async () => {
    const s = setup()
    vi.mocked(s.followUps.action).mockResolvedValueOnce({ ...fuView, kind: 'repeat_ask', status: 'cancelled', dueAt: null })
    const r = await handleActivity(fuClick({ action: 'cancel', followUpId: 'f1', kind: 'escalation', ref: followUpRef('f1', 'repeat') }), s.deps)
    const text = cardText(body(r).value)
    expect(s.followUps.action).toHaveBeenCalledWith(expect.anything(), 'f1', 'cancel', NOW)
    expect(text).toContain('Client asked again: Acme Traders')
    expect(text).toContain('Marked not a repeat by Asha')
  })

  it('extend: the card shows the new due date', async () => {
    const s = setup()
    const r = await handleActivity(fuClick({ action: 'extend', followUpId: 'f1', kind: 'escalation', ref: MISSED }), s.deps)
    const text = cardText(body(r).value)
    expect(text).toContain('Promise missed: Acme Traders')
    expect(text).toContain('Extended by 1 day by Asha')
    expect(text).toContain('New due date: 19 Nov, 6:00 pm')
  })

  it('refreshes the stored card copy after the answer when it has an activity id', async () => {
    const s = setup({
      rows: [
        { kind: 'escalation', ref_id: MISSED, client_id: 'c1', channel_id: '19:esc', activity_id: 'act-7', sent_at: '', action: null, action_by: null, action_at: null },
      ],
    })
    await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'escalation', ref: MISSED }), s.deps)
    expect(s.updated).toHaveLength(0)
    await s.runDeferred()
    expect(s.updated).toHaveLength(1)
    expect(s.updated[0]).toMatchObject({ conversationId: '19:esc', activityId: 'act-7' })
    expect(cardText(s.updated[0].activity)).toContain('Marked done by Asha')

    const none = setup()
    await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), none.deps)
    await none.runDeferred()
    expect(none.updated).toHaveLength(0)
  })

  it('Forbidden (another accountant, engineer, viewing as) gets the refusal', async () => {
    for (const email of ['ravi@x.in', 'eng@x.in']) {
      const s = setup({ email })
      const r = await handleActivity(fuClick({ action: 'done', followUpId: 'f1', kind: 'reminder', ref: DUE }), s.deps)
      expect(body(r)).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: REFUSAL })
    }
    const v = setup()
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
      const s = setup()
      vi.mocked(s.followUps.action).mockRejectedValueOnce(e)
      const r = await handleActivity(fuClick({ action: 'extend', followUpId: 'f1', kind: 'reminder', ref: DUE }), s.deps)
      expect(body(r).value).toBe(msg)
    }
    const s = setup()
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
    const s = setup()
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
    const s = setup()
    const r = await handleActivity(click({ action: 'start', ticketId: 't1', kind: 'ticket', ref: 't1' }), s.deps)
    expect(cardText(body(r).value)).toContain('Started by Asha')
    expect(s.followUps.action).not.toHaveBeenCalled()
  })
})
