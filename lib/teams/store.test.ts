import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import type { Database } from '@/lib/db/types'
import { createFakeSupabase, type FakeOptions, type FakeTables } from '@/lib/data/testing/fake-supabase'
import { CHANNELS_KEY, isActiveVa, parseChannelMap, parsePersonalChats, PERSONAL_KEY, supabaseTeamsStore } from './store'
import type { TeamsChannelMap } from './types'

const UNIQUE: FakeOptions = { unique: { teams_notifications: [['kind', 'ref_id']] } }

function setup(tables: FakeTables = {}, opts: FakeOptions = UNIQUE) {
  const fake = createFakeSupabase({ settings: [], teams_notifications: [], ...tables }, opts)
  const store = supabaseTeamsStore(fake.client as unknown as SupabaseClient<Database>)
  return { fake, store }
}

const MAP: TeamsChannelMap = {
  serviceUrl: 'https://smba.trafficmanager.net/in/',
  tenantId: 'tenant-1',
  teamId: 'team-1',
  accountants: { va1: { id: '19:a@thread.tacv2', name: 'Asha' } },
  escalations: { id: '19:e@thread.tacv2', name: null },
}

describe('channel map', () => {
  it('returns null when the setting is missing or not valid JSON', async () => {
    expect(await setup().store.channels()).toBeNull()
    const { store } = setup({ settings: [{ key: CHANNELS_KEY, value: '{not json', note: null }] })
    expect(await store.channels()).toBeNull()
    expect(parseChannelMap('[]')).toBeNull()
    expect(parseChannelMap('{"tenantId":"t"}')).toBeNull()
  })

  it('drops malformed channel refs', () => {
    const map = parseChannelMap(
      JSON.stringify({ serviceUrl: 's', tenantId: 't', accountants: { va1: { id: 'x' }, va2: { name: 'no id' }, va3: 5 }, escalations: 'bad' }),
    )
    expect(map).toEqual({ serviceUrl: 's', tenantId: 't', teamId: null, accountants: { va1: { id: 'x', name: null } }, escalations: null })
  })

  it('saveChannels inserts the row with a note, then updates it', async () => {
    const { fake, store } = setup()
    await store.saveChannels(MAP)
    expect(fake.tables.settings).toEqual([{ key: CHANNELS_KEY, value: JSON.stringify(MAP), note: 'Shadow Teams bot channel map' }])
    expect(await store.channels()).toEqual(MAP)

    const next = { ...MAP, escalations: null }
    await store.saveChannels(next)
    expect(fake.tables.settings).toHaveLength(1)
    expect(await store.channels()).toEqual(next)
    expect(fake.calls.filter((c) => c.table === 'settings' && c.op === 'insert')).toHaveLength(1)
  })
})

describe('1:1 chats (settings teams_personal)', () => {
  const chat = { conversationId: 'a:1', serviceUrl: 'https://smba.trafficmanager.net/in/', name: 'Asha', at: '2026-11-19T05:00:00.000Z' }

  it('parsePersonalChats keeps valid entries only, with lower-case emails', () => {
    expect(parsePersonalChats(null)).toEqual({})
    expect(parsePersonalChats('not json')).toEqual({})
    expect(parsePersonalChats('[]')).toEqual({})
    const value = JSON.stringify({ 'Asha@X.in': chat, 'bad@x.in': { conversationId: 'a:2' }, 'odd@x.in': 'x' })
    expect(parsePersonalChats(value)).toEqual({ 'asha@x.in': chat })
  })

  it('savePersonalChat inserts the row, then updates one entry and keeps the others', async () => {
    const { fake, store } = setup()
    expect(await store.personalChats()).toEqual({})
    await store.savePersonalChat('Asha@X.in', chat)
    await store.savePersonalChat('ravi@x.in', { ...chat, conversationId: 'a:2', name: 'Ravi' })
    await store.savePersonalChat('asha@x.in', { ...chat, conversationId: 'a:3' })
    expect(fake.tables.settings).toHaveLength(1)
    expect(fake.tables.settings[0]).toMatchObject({ key: PERSONAL_KEY })
    const chats = await store.personalChats()
    expect(Object.keys(chats).sort()).toEqual(['asha@x.in', 'ravi@x.in'])
    expect(chats['asha@x.in'].conversationId).toBe('a:3')
  })

  it('setActivityId can also move the row to the chat that got the card', async () => {
    const { fake, store } = setup()
    await store.claim({ kind: 'escalation', ref_id: 'r1', client_id: 'c1', channel_id: 'a:first' })
    await store.setActivityId('escalation', 'r1', 'act-9', 'a:second')
    expect(fake.tables.teams_notifications[0]).toMatchObject({ channel_id: 'a:second', activity_id: 'act-9' })
    await store.setActivityId('escalation', 'r1', 'act-10')
    expect(fake.tables.teams_notifications[0]).toMatchObject({ channel_id: 'a:second', activity_id: 'act-10' })
  })
})

describe('teams_notifications', () => {
  const row = { kind: 'ticket' as const, ref_id: 't1', client_id: 'c1', channel_id: '19:a' }

  it('claim inserts once and returns false for a duplicate', async () => {
    const { fake, store } = setup()
    expect(await store.claim(row)).toBe(true)
    expect(await store.claim(row)).toBe(false)
    expect(await store.claim({ ...row, kind: 'reminder' })).toBe(true)
    expect(fake.tables.teams_notifications).toHaveLength(2)
  })

  it('claim throws on any other error', async () => {
    const { store } = setup({}, { fail: ({ op }) => (op === 'insert' ? { message: 'boom', code: '42501' } : null) })
    await expect(store.claim(row)).rejects.toThrow('boom')
  })

  it('release deletes the row so a later claim succeeds', async () => {
    const { store } = setup()
    await store.claim(row)
    await store.release('ticket', 't1')
    expect(await store.get('ticket', 't1')).toBeNull()
    expect(await store.claim(row)).toBe(true)
  })

  it('sentRefs returns only refs of that kind, in chunks of 200', async () => {
    const existing = Array.from({ length: 250 }, (_, i) => ({ kind: 'ticket', ref_id: `t${i}`, channel_id: 'c' }))
    const { fake, store } = setup({ teams_notifications: [...existing, { kind: 'files', ref_id: 'u1', channel_id: 'c' }] })
    const ids = [...Array.from({ length: 300 }, (_, i) => `t${i}`), 'u1']
    const sent = await store.sentRefs('ticket', ids)
    expect(sent.size).toBe(250)
    expect(sent.has('u1')).toBe(false)
    expect(fake.calls.filter((c) => c.table === 'teams_notifications' && c.op === 'select')).toHaveLength(2)
    expect((await store.sentRefs('ticket', [])).size).toBe(0)
  })

  it('setActivityId, recordAction and get', async () => {
    const { store } = setup()
    await store.claim(row)
    await store.setActivityId('ticket', 't1', 'act-1')
    await store.recordAction('ticket', 't1', 'started', 'asha@example.com', '2026-11-18T10:00:00Z')
    expect(await store.get('ticket', 't1')).toMatchObject({
      kind: 'ticket',
      ref_id: 't1',
      client_id: 'c1',
      channel_id: '19:a',
      activity_id: 'act-1',
      action: 'started',
      action_by: 'asha@example.com',
      action_at: '2026-11-18T10:00:00Z',
    })
  })

  it('recordAction on a missing row does nothing', async () => {
    const { fake, store } = setup()
    await store.recordAction('ticket', 'nope', 'closed', 'a@example.com', '2026-11-18T10:00:00Z')
    expect(fake.tables.teams_notifications).toHaveLength(0)
  })
})

describe('ticketForCard', () => {
  const tables = (): FakeTables => ({
    vas: [
      { va_id: 'va1', va_name: 'Asha' },
      { va_id: 'va2', va_name: 'Ravi' },
    ],
    clients: [{ client_id: 'c1', client_name: 'Alpha Traders', va_id: 'va1' }],
    conversations: [
      {
        id: 't1',
        client_id: 'c1',
        va_id: null,
        title: 'Login help',
        summary: 'Client shared password: hunter2 for the portal',
        tag: 'query',
        status: 'open',
        opened_at: '2026-11-18T08:00:00Z',
        last_message_at: '2026-11-18T09:00:00Z',
        last_message_direction: 'incoming',
        sla_breached: true,
      },
      {
        id: 't2',
        client_id: 'c1',
        va_id: 'va2',
        title: null,
        summary: 'GST',
        tag: null,
        status: 'closed',
        opened_at: '2026-11-17T08:00:00Z',
        last_message_at: '2026-11-17T09:00:00Z',
        last_message_direction: 'outgoing',
        sla_breached: false,
      },
    ],
  })

  it('maps the ticket, falls back to the client accountant and masks credentials', async () => {
    const card = await setup(tables()).store.ticketForCard('t1')
    expect(card).toMatchObject({
      id: 't1',
      clientId: 'c1',
      clientName: 'Alpha Traders',
      title: 'Login help',
      tag: 'query',
      status: 'open',
      openedAt: '2026-11-18T08:00:00Z',
      lastMessageAt: '2026-11-18T09:00:00Z',
      lastMessageDirection: 'incoming',
      vaId: 'va1',
      vaName: 'Asha',
      slaBreached: true,
    })
    expect(card?.summary).not.toContain('hunter2')
  })

  it('uses conversations.va_id when set', async () => {
    expect(await setup(tables()).store.ticketForCard('t2')).toMatchObject({ vaId: 'va2', vaName: 'Ravi', title: null })
  })

  it('returns null for a missing ticket', async () => {
    expect(await setup(tables()).store.ticketForCard('nope')).toBeNull()
    expect(await setup(tables()).store.ticketForCard('')).toBeNull()
  })
})

describe('accountants', () => {
  it('lists active (or blank status) accountants sorted by name', async () => {
    const { store } = setup({
      vas: [
        { va_id: 'va3', va_name: 'Zoya', email: 'z@example.com', status: null, teams_user_id: null },
        { va_id: 'va1', va_name: 'Asha', email: 'a@example.com', status: 'Active', teams_user_id: '29:abc' },
        { va_id: 'va2', va_name: 'Mohan', email: null, status: 'inactive', teams_user_id: null },
      ],
    })
    expect(await store.accountants()).toEqual([
      { vaId: 'va1', name: 'Asha', email: 'a@example.com', teamsUserId: '29:abc' },
      { vaId: 'va3', name: 'Zoya', email: 'z@example.com', teamsUserId: null },
    ])
  })

  it('isActiveVa is lenient', () => {
    expect(isActiveVa(null)).toBe(true)
    expect(isActiveVa(' ACTIVE ')).toBe(true)
    expect(isActiveVa('left')).toBe(false)
  })
})
