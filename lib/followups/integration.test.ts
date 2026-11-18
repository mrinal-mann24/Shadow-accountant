import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// End-to-end scenarios for follow-ups. The REAL job, store (over the in-memory fake Supabase), prefilter, extractor
// (createFollowUpAI with a scripted `call` in place of the model), date helpers, Teams cards, lib/data followUpAction
// and the bot's card-click handler are wired together. Only the model, the Teams store and the Teams connector are
// fakes. The job is run on the real cron slots (5, 20, 35 and 50 past the hour) over simulated days.
// 'server-only' is a no-op through the vitest alias (vitest.config.ts), like every other server test.

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import { ForbiddenError } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'
import { followUpAction } from '@/lib/data'
import { createFakeSupabase, type FakeTables } from '@/lib/data/testing/fake-supabase'
import type { Database } from '@/lib/db/types'
import { clearTeamNumbersCache } from '@/lib/team'
import { handleActivity, REFUSAL, resetBotState, type BotDeps } from '@/lib/teams/bot'
import type {
  Activity,
  AdaptiveCard,
  NotificationKind,
  NotificationRow,
  OutgoingActivity,
  TeamsChannelMap,
  TeamsConnector,
  TeamsStore,
} from '@/lib/teams/types'
import { createFollowUpAI, type ObjectCallArgs } from './extract'
import { runFollowUpsJob } from './job'
import { followUpViews, supabaseFollowUpStore } from './store'
import { followUpCycle, followUpRef, type FollowUpCardData, type FollowUpRow } from './types'

// ---------------------------------------------------------------- clock and fixtures

const ist = (local: string) => new Date(`${local}+05:30`).toISOString()
const SITE = 'https://shadow.test'
const TENANT = 'tenant-1'
const TEAM_PHONE = '+91 90000 00009' // Asha's personal WhatsApp, stored by va-bot as 'incoming'
const CLIENT_PHONE = '9800000001'

const asha: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const ravi: AppUser = { id: 'u2', email: 'ravi@example.com', name: 'Ravi', role: 'senior_accountant', vaId: 'va2' }

const MAP: TeamsChannelMap = {
  serviceUrl: 'https://smba.trafficmanager.net/in/',
  tenantId: TENANT,
  teamId: 'team',
  accountants: { va1: { id: 'ch-va1', name: 'Asha' }, va2: { id: 'ch-va2', name: 'Ravi' } },
  escalations: { id: 'ch-esc', name: 'Escalations' },
}

function baseTables(): FakeTables {
  return {
    settings: [],
    vas: [
      { va_id: 'va1', va_name: 'Asha', email: 'asha@example.com', whatsapp_number: '9000000009' },
      { va_id: 'va2', va_name: 'Ravi', email: 'ravi@example.com', whatsapp_number: '9000000010' },
    ],
    clients: [
      { client_id: 'c1', client_name: 'Acme Traders', va_id: 'va1', council_enabled: true, status: 'Active' },
      { client_id: 'c2', client_name: 'Beta Foods', va_id: 'va2', council_enabled: false, status: 'Active' },
    ],
    conversations: [],
    client_messages: [],
    document_uploads: [],
    follow_ups: [],
  }
}

// ---------------------------------------------------------------- scripted model

type TeamOut = { promises?: { item: string; due_date: string | null; due_time: string | null }[]; document_requests?: { item: string }[] }
type Script = {
  /** Team message body -> what the model extracts. A team message the prefilter passes must be scripted. */
  team?: Record<string, TeamOut>
  /** Client message body -> null (no repeat ask) or the repeat ask (repeatsBody: earlier client message it repeats). */
  client?: Record<string, { item: string; repeatsBody: string | null } | null>
  /** Evidence text (message body or file name) -> open items it delivers, by item text. Unscripted evidence delivers nothing. */
  delivers?: Record<string, RegExp>
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** All <message> tags of a prompt section, in order. */
function messagesIn(section: string): { id: string; body: string }[] {
  return [...section.matchAll(/<message id="([^"]*)"[^>]*>([\s\S]*?)<\/message>/g)].map((m) => ({ id: m[1], body: unescape(m[2]) }))
}

type ModelCall = { schema: string; text: string }

function scriptedModel(script: Script) {
  const calls: ModelCall[] = []
  const call = async ({ prompt, schemaName }: ObjectCallArgs): Promise<unknown> => {
    if (schemaName === 'follow_up_team') {
      const [, newPart] = prompt.split('NEW MESSAGE FROM OUR TEAM:')
      const body = messagesIn(newPart)[0].body
      calls.push({ schema: 'team', text: body })
      const out = script.team?.[body]
      if (!out) throw new Error(`unscripted team message: ${body}`)
      return { promises: out.promises ?? [], document_requests: out.document_requests ?? [] }
    }
    if (schemaName === 'follow_up_client') {
      const [before, newPart] = prompt.split('NEW MESSAGE FROM THE CLIENT:')
      const body = messagesIn(newPart)[0].body
      calls.push({ schema: 'client', text: body })
      if (!script.client || !(body in script.client)) throw new Error(`unscripted client message: ${body}`)
      const out = script.client[body]
      if (!out) return { repeat_ask: null }
      const earlier = out.repeatsBody ? messagesIn(before.split('RECENT MESSAGES BEFORE IT')[1] ?? '').find((m) => m.body === out.repeatsBody) : undefined
      return { repeat_ask: { item: out.item, repeats_message_id: earlier?.id ?? null } }
    }
    if (schemaName === 'follow_up_delivery') {
      const evidence = unescape(/<evidence[^>]*>([\s\S]*?)<\/evidence>/.exec(prompt)![1])
      calls.push({ schema: 'delivery', text: evidence })
      const open = [...prompt.matchAll(/- id: (\S+) \| kind: \S+ \| since: \S+ \| <item>([\s\S]*?)<\/item>/g)].map((m) => ({ id: m[1], item: unescape(m[2]) }))
      const rule = script.delivers?.[evidence]
      return { delivered_ids: rule ? open.filter((o) => rule.test(o.item)).map((o) => o.id) : [] }
    }
    throw new Error(`unexpected schema ${schemaName}`)
  }
  return { ai: createFollowUpAI({ call }), calls }
}

// ---------------------------------------------------------------- Teams fakes

type Sent = { at: string; channel: string; card: AdaptiveCard; text: string }

function fakeTeams(now: () => Date) {
  const key = (k: NotificationKind, ref: string) => `${k}:${ref}`
  const rows = new Map<string, NotificationRow>()
  const store: TeamsStore = {
    channels: async () => structuredClone(MAP),
    saveChannels: async () => {},
    sentRefs: async (kind, refs) => new Set(refs.filter((r) => rows.has(key(kind, r)))),
    claim: async (r) => {
      if (rows.has(key(r.kind, r.ref_id))) return false
      rows.set(key(r.kind, r.ref_id), { ...r, activity_id: null, sent_at: now().toISOString(), action: null, action_by: null, action_at: null })
      return true
    },
    release: async (kind, ref) => {
      rows.delete(key(kind, ref))
    },
    setActivityId: async (kind, ref, id) => {
      const r = rows.get(key(kind, ref))
      if (r) r.activity_id = id
    },
    get: async (kind, ref) => rows.get(key(kind, ref)) ?? null,
    recordAction: async () => {},
    ticketForCard: async () => null,
    accountants: async () => [],
  }
  const sent: Sent[] = []
  const updated: { channel: string; activityId: string; activity: OutgoingActivity }[] = []
  const emails: Record<string, string> = { '29:asha': asha.email, '29:ravi': ravi.email }
  const connector: TeamsConnector = {
    send: async (_url, channel, activity) => {
      const card = activity.attachments![0].content
      sent.push({ at: now().toISOString(), channel, card, text: JSON.stringify(card) })
      return { id: `act-${sent.length}` }
    },
    update: async (_url, channel, activityId, activity) => {
      updated.push({ channel, activityId, activity })
    },
    member: async (_url, _conv, userId) => ({ email: emails[userId] ?? null, name: null, aadObjectId: null }),
  }
  return { store, connector, rows, sent, updated }
}

/** The data of a button on a sent follow-up card, by title. */
function button(card: AdaptiveCard, title: string): FollowUpCardData {
  const a = (card.actions as { type: string; title: string; verb?: string; data?: FollowUpCardData }[]).find((x) => x.title === title)
  expect(a?.type).toBe('Action.Execute')
  expect(a?.verb).toBe('followup')
  return a!.data!
}

// ---------------------------------------------------------------- the world

function world(script: Script) {
  const tables = baseTables()
  const fake = createFakeSupabase(tables, { unique: { follow_ups: [['source_message_id', 'kind', 'item']] } })
  const clock = { now: new Date(ist('2026-11-01T00:00:00')) }
  let n = 0
  // follow_ups column defaults, as the proposed table has them (id, status, reminder_count, created_at = now()).
  const client = {
    from(table: string) {
      const q = fake.client.from(table)
      if (table !== 'follow_ups') return q
      const insert = q.insert.bind(q)
      return Object.assign(q, {
        insert: (rows: Record<string, unknown> | Record<string, unknown>[]) =>
          insert(
            (Array.isArray(rows) ? rows : [rows]).map((r) => ({
              id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
              status: 'open',
              resolved_at: null,
              resolved_by: null,
              resolved_message_id: null,
              resolved_upload_id: null,
              reminder_count: 0,
              last_reminded_at: null,
              escalated_at: null,
              created_at: clock.now.toISOString(),
              ...r,
            })),
          ),
      })
    },
  }
  const db = client as unknown as SupabaseClient<Database>
  state.db = db
  const model = scriptedModel(script)
  const teams = fakeTeams(() => clock.now)
  const store = supabaseFollowUpStore(db)
  const pending: { at: number; apply: () => void }[] = []
  const results: Awaited<ReturnType<typeof runFollowUpsJob>>[] = []

  const w = {
    tables,
    clock,
    model,
    teams,
    db,
    results,
    rows: () => tables.follow_ups as unknown as FollowUpRow[],
    row: (item: RegExp) => {
      const found = (tables.follow_ups as unknown as FollowUpRow[]).filter((r) => item.test(r.item))
      expect(found).toHaveLength(1)
      return found[0]
    },
    /** A WhatsApp message, landing in client_messages 30 s after its message time (va-bot). */
    message(id: string, local: string, body: string, o: { team?: boolean } = {}) {
      const ts = ist(local)
      const created = new Date(Date.parse(ts) + 30_000).toISOString()
      pending.push({
        at: Date.parse(created),
        apply: () =>
          tables.client_messages.push({
            message_id: id,
            client_id: 'c1',
            conversation_id: null,
            body,
            direction: 'incoming',
            sender_name: o.team ? 'Asha' : 'Rahul (Acme)',
            sender_phone: o.team ? TEAM_PHONE : CLIENT_PHONE,
            message_timestamp: ts,
            created_at: created,
          }),
      })
    },
    upload(id: string, local: string, fileName: string, o: { team?: boolean } = {}) {
      const at = ist(local)
      pending.push({
        at: Date.parse(at),
        apply: () =>
          tables.document_uploads.push({ upload_id: id, client_id: 'c1', file_name: fileName, uploaded_at: at, sender_phone: o.team ? TEAM_PHONE : CLIENT_PHONE }),
      })
    },
    /** One job run at an IST wall time (write mode). Every run must be error free. */
    async runAt(local: string, since: string | null = null) {
      clock.now = new Date(ist(local))
      for (const p of pending.filter((x) => x.at <= clock.now.getTime())) {
        p.apply()
        pending.splice(pending.indexOf(p), 1)
      }
      const res = await runFollowUpsJob(
        { write: true, now: clock.now, since },
        { store, ai: model.ai, teamsStore: teams.store, connector: teams.connector, views: (ids) => followUpViews(ids, db), siteUrl: SITE },
      )
      expect(res.errors, `run at ${local}`).toEqual([])
      results.push(res)
      return res
    },
    /** Every cron slot (hh:05, :20, :35, :50) from `from` to `to`, IST. `from` must be a slot. */
    async cron(from: string, to: string, since: string | null = null) {
      const end = Date.parse(ist(to))
      for (let t = Date.parse(ist(from)); t <= end; t += 15 * 60_000) {
        const local = new Date(t + 330 * 60_000).toISOString().slice(0, 19)
        await w.runAt(local, since)
      }
    },
    /** The cards sent, as [IST time, channel, ref]. */
    cards: () => teams.sent.map((s) => [new Date(Date.parse(s.at) + 330 * 60_000).toISOString().slice(0, 16), s.channel, refOf(s.card)]),
  }
  return w
}

/** Refs carry the alert cycle (day of the due date): due / missed n = cycle, chase n = cycle * 10 + k. */
const dueRef = (r: FollowUpRow) => followUpRef(r.id, 'due', followUpCycle(r.due_at))
const missedRef = (r: FollowUpRow) => followUpRef(r.id, 'missed', followUpCycle(r.due_at))
const chaseRef = (r: FollowUpRow, k: number) => followUpRef(r.id, 'chase', followUpCycle(r.due_at) * 10 + k)

function refOf(card: AdaptiveCard): string {
  const a = (card.actions as { data?: { ref?: string } }[]).find((x) => x.data?.ref)
  return a?.data?.ref ?? '(no ref)'
}

function invoke(fromId: string, data: FollowUpCardData, id?: string): Activity {
  return {
    type: 'invoke',
    name: 'adaptiveCard/action',
    ...(id ? { id } : {}),
    value: { action: { type: 'Action.Execute', verb: 'followup', data } },
    serviceUrl: MAP.serviceUrl,
    channelId: 'msteams',
    from: { id: fromId, name: 'Someone' },
    recipient: { id: '28:bot', name: 'Shadow' },
    conversation: { id: '19:ch-va1@thread.tacv2;messageid=1', tenantId: TENANT, conversationType: 'channel' },
    channelData: { tenant: { id: TENANT } },
  }
}

function botDeps(w: ReturnType<typeof world>): { deps: BotDeps; runDeferred: () => Promise<void> } {
  const tasks: (() => Promise<void>)[] = []
  const users: Record<string, AppUser> = { [asha.email]: asha, [ravi.email]: ravi }
  const deps: BotDeps = {
    connector: w.teams.connector,
    store: w.teams.store,
    resolveUser: async (email) => users[email.toLowerCase()] ?? null,
    ask: async () => {
      throw new Error('not used')
    },
    data: {
      updateConversation: async () => {
        throw new Error('not used')
      },
      ticketForUser: async () => null,
      reassignTicket: async () => {
        throw new Error('not used')
      },
    },
    followUps: { action: followUpAction }, // the real lib/data function over the fake database
    siteUrl: SITE,
    tenantId: TENANT,
    now: () => w.clock.now,
    defer: (t) => {
      tasks.push(t)
    },
  }
  return {
    deps,
    runDeferred: async () => {
      for (const t of tasks.splice(0)) await t()
    },
  }
}

type ReplyBody = { statusCode: number; type: string; value: unknown }

beforeEach(() => {
  clearTeamNumbersCache()
  resetBotState()
})

// ---------------------------------------------------------------- a) promise tracker

describe('a) promise: due reminder, then delivered', () => {
  it('"we will share the MIS by tomorrow" -> due next business day 19:00, one due card, done on "Here is the MIS", never missed', async () => {
    const w = world({
      team: {
        'Sir, we will share the MIS by tomorrow': { promises: [{ item: 'Share the MIS', due_date: '2026-11-19', due_time: null }] },
        'Here is the MIS': {},
      },
      delivers: { 'Here is the MIS': /MIS/ },
    })
    w.message('m-a1', '2026-11-18T10:30:00', 'Sir, we will share the MIS by tomorrow', { team: true }) // Wednesday
    w.message('m-a2', '2026-11-19T16:00:00', 'Here is the MIS', { team: true })

    await w.cron('2026-11-18T10:35:00', '2026-11-18T23:50:00')
    expect(w.rows()).toHaveLength(1)
    const p = w.row(/MIS/)
    expect(p).toMatchObject({
      kind: 'promise',
      item: 'Share the MIS',
      source_message_id: 'm-a1',
      due_at: ist('2026-11-19T19:00:00'), // Thursday, next business day, 19:00 IST
      status: 'open',
      reminder_count: 0,
      created_at: ist('2026-11-18T10:35:00'),
    })
    expect(w.teams.sent).toHaveLength(0)

    await w.cron('2026-11-19T00:05:00', '2026-11-19T15:50:00')
    expect(w.cards()).toEqual([['2026-11-19T10:05', 'ch-va1', dueRef(p)]])
    expect(w.teams.sent[0].text).toContain('Promise due today: Acme Traders')
    expect([...w.teams.rows.keys()]).toEqual([`reminder:${dueRef(p)}`])
    expect(w.row(/MIS/)).toMatchObject({ status: 'open', reminder_count: 1, last_reminded_at: ist('2026-11-19T10:05:00') })

    await w.cron('2026-11-19T16:05:00', '2026-11-20T12:00:00')
    expect(w.row(/MIS/)).toMatchObject({ status: 'done', resolved_by: 'ai', resolved_message_id: 'm-a2', resolved_at: ist('2026-11-19T16:00:00') })
    expect(w.teams.sent).toHaveLength(1)
    expect(w.teams.sent.some((s) => s.text.includes('missed'))).toBe(false)
    expect(w.results.flatMap((r) => (r.details as { alerts: { missed: string[] } }).alerts.missed)).toEqual([])
    // Model calls: the promise message, then "Here is the MIS" (delivery check + prefilter pass). Nothing else.
    expect(w.model.calls).toEqual([
      { schema: 'team', text: 'Sir, we will share the MIS by tomorrow' },
      { schema: 'delivery', text: 'Here is the MIS' },
      { schema: 'team', text: 'Here is the MIS' },
    ])
  })
})

// ---------------------------------------------------------------- b) document chase list

const DOC_SCRIPT: Script = {
  team: {
    'Please share CC statement and bank statement for Oct': {
      document_requests: [{ item: 'CC statement October' }, { item: 'Bank statement October' }],
    },
  },
  delivers: { 'HDFC_Bank_Statement_Oct.pdf': /bank statement/i },
}

async function documentScenario() {
  const w = world(DOC_SCRIPT)
  w.message('m-b1', '2026-11-18T11:00:00', 'Please share CC statement and bank statement for Oct', { team: true }) // Wednesday
  w.upload('u-b1', '2026-11-18T15:00:00', 'HDFC_Bank_Statement_Oct.pdf')
  await w.cron('2026-11-18T11:05:00', '2026-11-18T14:50:00')
  return w
}

describe('b) document requests: chase, chase, chase, escalate', () => {
  it('two items; the bank statement upload closes only that one; 3 chases every 2 business days, one escalation, then silence', async () => {
    const w = await documentScenario()
    expect(w.rows().map((r) => [r.kind, r.item, r.status, r.due_at])).toEqual([
      ['document', 'CC statement October', 'open', ist('2026-11-20T19:00:00')], // Friday: 2 business days, 19:00
      ['document', 'Bank statement October', 'open', ist('2026-11-20T19:00:00')],
    ])

    await w.cron('2026-11-18T15:05:00', '2026-11-18T15:05:00')
    const cc = w.row(/^CC/)
    expect(cc.status).toBe('open')
    expect(w.row(/^Bank/)).toMatchObject({ status: 'done', resolved_by: 'ai', resolved_upload_id: 'u-b1', resolved_message_id: null })

    await w.cron('2026-11-18T15:20:00', '2026-12-02T19:50:00')
    const refs = w.cards().map((c) => c[2])
    expect(refs).toEqual([
      chaseRef(cc, 1),
      chaseRef(cc, 2),
      chaseRef(cc, 3),
      missedRef(cc),
    ])
    expect(w.cards().slice(0, 3)).toEqual([
      ['2026-11-21T10:05', 'ch-va1', chaseRef(cc, 1)], // Saturday, first in-hours run after Friday 19:00
      ['2026-11-24T10:05', 'ch-va1', chaseRef(cc, 2)], // Tuesday, 18 business hours later
      ['2026-11-26T10:05', 'ch-va1', chaseRef(cc, 3)], // Thursday
    ])
    expect(w.cards()[3][1]).toBe('ch-esc')
    expect(w.teams.sent[0].text).toContain('Chase document: Acme Traders')
    expect(w.teams.sent[0].text).toContain('reminder 1')
    expect(w.teams.sent[2].text).toContain('reminder 3')
    expect(w.teams.sent[3].text).toContain('Document still not received: Acme Traders')
    expect(w.teams.sent.every((s) => !s.text.includes('Bank statement'))).toBe(true)
    expect(w.row(/^CC/)).toMatchObject({ status: 'open', reminder_count: 3 })
    expect(w.row(/^CC/).escalated_at).not.toBeNull()
    expect([...w.teams.rows.keys()].sort()).toEqual(
      [
        `escalation:${missedRef(cc)}`,
        `reminder:${chaseRef(cc, 1)}`,
        `reminder:${chaseRef(cc, 2)}`,
        `reminder:${chaseRef(cc, 3)}`,
      ].sort(),
    )
  })

  // Fixed: the escalation rests 2 business days after the third chase, like the chases themselves.
  it('the escalation waits the same 2 business days after the third chase', async () => {
    const w = await documentScenario()
    await w.cron('2026-11-18T15:05:00', '2026-12-02T19:50:00')
    const escalation = w.cards()[3]
    expect(escalation[0]).toBe('2026-11-28T10:05') // Saturday 10:05 = 18 business hours after Thursday 10:05
    // The bank statement file was checked once, not again on every run inside the 48 h overlap.
    expect(w.model.calls.filter((c) => c.schema === 'delivery')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- c) repeat-ask alarm

describe('c) repeat ask', () => {
  it('a second ask 2 hours later alarms at once (escalation + accountant); the next team message answers it; no more cards', async () => {
    const w = world({
      client: {
        'When will the GST be filed?': null,
        'Any update on GST?': { item: 'GST filing status', repeatsBody: 'When will the GST be filed?' },
      },
      team: { 'Sir, GSTR-3B is filed, ARN shared on mail': {} },
    })
    w.message('m-c1', '2026-11-18T12:00:00', 'When will the GST be filed?')
    w.message('m-c2', '2026-11-18T14:00:00', 'Any update on GST?')
    w.message('m-c3', '2026-11-18T14:30:00', 'Sir, GSTR-3B is filed, ARN shared on mail', { team: true })

    await w.cron('2026-11-18T12:05:00', '2026-11-18T13:50:00')
    expect(w.rows()).toHaveLength(0) // a first-time question is not a repeat ask
    await w.runAt('2026-11-18T14:05:00')
    const r = w.row(/GST/)
    expect(r).toMatchObject({ kind: 'repeat_ask', item: 'GST filing status', source_message_id: 'm-c2', due_at: null, status: 'open' })
    const ref = followUpRef(r.id, 'repeat', 0)
    expect(w.cards()).toEqual([
      ['2026-11-18T14:05', 'ch-esc', ref],
      ['2026-11-18T14:05', 'ch-va1', ref],
    ])
    expect(w.teams.sent[0].text).toContain('Client asked again: Acme Traders')
    expect([...w.teams.rows.keys()]).toEqual([`escalation:${ref}`, `reminder:${ref}`])
    expect(w.row(/GST/).escalated_at).toBe(ist('2026-11-18T14:05:00'))

    await w.cron('2026-11-18T14:20:00', '2026-11-18T14:20:00')
    expect(w.teams.sent).toHaveLength(2) // escalated once, never again while it waits
    await w.cron('2026-11-18T14:35:00', '2026-11-20T19:50:00')
    expect(w.row(/GST/)).toMatchObject({ status: 'done', resolved_by: 'ai', resolved_message_id: 'm-c3' })
    expect(w.teams.sent).toHaveLength(2)
    // The answer needed no delivery check (no promise was open); the team call is the prefilter pass on "GSTR".
    expect(w.model.calls).toEqual([
      { schema: 'client', text: 'When will the GST be filed?' },
      { schema: 'client', text: 'Any update on GST?' },
      { schema: 'team', text: 'Sir, GSTR-3B is filed, ARN shared on mail' },
    ])
  })
})

// ---------------------------------------------------------------- d) history backfill

describe('d) history', () => {
  it('items from 10-day-old messages are never alerted; an undelivered old promise ends missed, a delivered one done', async () => {
    const w = world({
      team: {
        'Will share the GST working by tomorrow': { promises: [{ item: 'Share the GST working', due_date: '2026-11-10', due_time: null }] },
        'Will send the P&L by tomorrow': { promises: [{ item: 'Send the P&L', due_date: '2026-11-10', due_time: null }] },
        'Please send the purchase invoices for October': { document_requests: [{ item: 'Purchase invoices October' }] },
        'Here is the P&L': {},
      },
      client: { 'Still waiting for the TDS challan, any update?': { item: 'TDS challan', repeatsBody: null } },
      delivers: { 'Here is the P&L': /P&L/ },
    })
    w.message('m-d1', '2026-11-09T11:00:00', 'Will share the GST working by tomorrow', { team: true }) // Monday, 9 days before
    w.message('m-d2', '2026-11-09T11:30:00', 'Will send the P&L by tomorrow', { team: true })
    w.message('m-d3', '2026-11-09T12:00:00', 'Please send the purchase invoices for October', { team: true })
    w.message('m-d4', '2026-11-10T15:00:00', 'Here is the P&L', { team: true })
    w.message('m-d5', '2026-11-10T16:00:00', 'Still waiting for the TDS challan, any update?')

    // First ever run (no watermark) on Wednesday 18 Nov, with a 30-day backfill start.
    const since = ist('2026-10-19T00:00:00')
    const first = await w.runAt('2026-11-18T10:05:00', since)
    expect(w.rows().map((r) => [r.kind, r.item, r.status])).toEqual([
      ['promise', 'Share the GST working', 'missed'],
      ['promise', 'Send the P&L', 'done'],
      ['document', 'Purchase invoices October', 'open'],
      ['repeat_ask', 'TDS challan', 'open'],
    ])
    expect(w.row(/P&L/)).toMatchObject({ resolved_message_id: 'm-d4', resolved_at: ist('2026-11-10T15:00:00') })
    const alerts = (first.details as { alerts: { missed: string[]; history: number } }).alerts
    expect(alerts.missed).toEqual([w.row(/GST working/).id])
    expect(alerts.history).toBe(3)

    await w.cron('2026-11-18T10:20:00', '2026-11-24T19:50:00', since)
    expect(w.teams.sent).toEqual([])
    expect(w.teams.rows.size).toBe(0)
    // History: escalated_at is set with no card, so later runs do not read them for alerts.
    expect(w.row(/GST working/)).toMatchObject({ status: 'missed', resolved_by: 'ai', escalated_at: ist('2026-11-18T10:05:00'), reminder_count: 0 })
    expect(w.row(/Purchase/)).toMatchObject({ status: 'open', escalated_at: ist('2026-11-18T10:05:00'), reminder_count: 0 })
    expect(w.row(/TDS/)).toMatchObject({ status: 'open', escalated_at: ist('2026-11-18T10:05:00') })
    expect(w.results.slice(1).every((r) => (r.details as { alerts: { candidates: number } }).alerts.candidates === 0)).toBe(true)
    expect(w.rows()).toHaveLength(4)
  })
})

// ---------------------------------------------------------------- e) business hours

describe('e) business hours', () => {
  it('a Saturday 18:50 promise due "today": no due reminder out of hours, missed at 19:05, escalated once on Monday 10:05', async () => {
    const w = world({
      team: { 'Will send the ledger today sir': { promises: [{ item: 'Send the ledger', due_date: '2026-11-21', due_time: null }] } },
    })
    w.message('m-e1', '2026-11-21T18:50:00', 'Will send the ledger today sir', { team: true }) // Saturday

    await w.cron('2026-11-21T18:35:00', '2026-11-21T18:50:00')
    expect(w.rows()).toHaveLength(0) // lands in client_messages at 18:50:30

    await w.cron('2026-11-21T19:05:00', '2026-11-23T12:50:00') // through Sunday to Monday noon
    const p = w.row(/ledger/)
    expect(p).toMatchObject({ due_at: ist('2026-11-21T19:00:00'), status: 'missed', reminder_count: 0 })
    // No "due" reminder ever (19:05 Saturday and all of Sunday are outside 10:00 to 19:00 Mon to Sat).
    expect(w.teams.sent.filter((s) => refOf(s.card).includes(':due:'))).toEqual([])
    // The status turns missed at Saturday 19:05; the escalation waits for business hours (Monday 10:05).
    expect(w.cards()).toEqual([['2026-11-23T10:05', 'ch-esc', missedRef(p)]])
    expect(w.teams.sent[0].text).toContain('Promise missed: Acme Traders')
    // Nothing on Saturday night or Sunday.
    expect(w.teams.sent.filter((s) => s.at < ist('2026-11-23T10:00:00'))).toEqual([])
  })

  // Fixed: a Sunday deadline moves to Monday 19:00 IST (resolveDue), so it is reminded in business hours.
  it('a Saturday "by tomorrow" promise gets a due reminder before it can be missed', async () => {
    const w = world({
      team: { 'Will send the ledger by tomorrow sir': { promises: [{ item: 'Send the ledger', due_date: '2026-11-22', due_time: null }] } },
    })
    w.message('m-e2', '2026-11-21T17:00:00', 'Will send the ledger by tomorrow sir', { team: true }) // Saturday
    await w.cron('2026-11-21T17:05:00', '2026-11-23T19:50:00')
    const p = w.row(/ledger/)
    expect(p.due_at).toBe(ist('2026-11-23T19:00:00'))
    expect(w.cards()).toEqual([['2026-11-23T10:05', 'ch-va1', dueRef(p)]])
  })
})

// ---------------------------------------------------------------- f) button path

describe('f) card buttons', () => {
  it('the chase card "Done" button: another accountant is refused, the client accountant closes it, no more chases', async () => {
    const w = await documentScenario()
    await w.cron('2026-11-18T15:05:00', '2026-11-21T10:05:00') // through the first chase (Saturday 10:05)
    const cc = w.row(/^CC/)
    expect(w.cards()).toEqual([['2026-11-21T10:05', 'ch-va1', chaseRef(cc, 1)]])
    const done = button(w.teams.sent[0].card, 'Done')
    expect(done).toEqual({ action: 'done', followUpId: cc.id, kind: 'reminder', ref: chaseRef(cc, 1) })

    w.clock.now = new Date(ist('2026-11-21T11:00:00'))
    // lib/data directly: Ravi (another accountant) is forbidden and nothing changes.
    await expect(followUpAction(ravi, cc.id, 'done', w.clock.now)).rejects.toBeInstanceOf(ForbiddenError)
    expect(w.row(/^CC/)).toMatchObject({ status: 'open', resolved_by: null })

    // The bot path with the button's own data.
    const bot = botDeps(w)
    const refused = await handleActivity(invoke('29:ravi', done, 'click-1'), bot.deps)
    expect((refused.body as ReplyBody).value).toBe(REFUSAL)
    expect(w.row(/^CC/).status).toBe('open')

    const ok = await handleActivity(invoke('29:asha', done, 'click-2'), bot.deps)
    const body = ok.body as ReplyBody
    expect(body.type).toBe('application/vnd.microsoft.card.adaptive')
    expect(JSON.stringify(body.value)).toContain('Marked done by Asha')
    expect(w.row(/^CC/)).toMatchObject({ status: 'done', resolved_by: asha.email, resolved_at: ist('2026-11-21T11:00:00') })
    await bot.runDeferred()
    expect(w.teams.updated.map((u) => [u.channel, u.activityId])).toEqual([['ch-va1', 'act-1']])

    // A second click (another viewer) is told it is closed; the job never chases or escalates it again.
    await expect(followUpAction(asha, cc.id, 'done', w.clock.now)).rejects.toThrow('This follow-up is already closed.')
    await w.cron('2026-11-21T11:05:00', '2026-12-02T19:50:00')
    expect(w.teams.sent).toHaveLength(1)
    expect(w.row(/^CC/)).toMatchObject({ status: 'done', reminder_count: 1, escalated_at: null })
  })
})
