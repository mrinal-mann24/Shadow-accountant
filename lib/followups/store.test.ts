import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import type { Database } from '@/lib/db/types'
import { createFakeSupabase, type FakeOptions, type FakeTables } from '@/lib/data/testing/fake-supabase'
import { followUpViews, parseWatermark, supabaseFollowUpStore, WATERMARK_KEY } from './store'
import { FollowUpsTableMissingError, type FollowUpRow } from './types'

const UNIQUE: FakeOptions = { unique: { follow_ups: [['source_message_id', 'kind', 'item']] } }

function fu(id: string, over: Partial<FollowUpRow> = {}): FollowUpRow {
  return {
    id,
    client_id: 'c1',
    conversation_id: null,
    kind: 'promise',
    source_message_id: 'm1',
    item: `item ${id}`,
    due_at: '2026-11-18T13:30:00.000Z',
    status: 'open',
    resolved_at: null,
    resolved_by: null,
    resolved_message_id: null,
    resolved_upload_id: null,
    reminder_count: 0,
    last_reminded_at: null,
    escalated_at: null,
    created_at: '2026-11-17T06:00:00.000Z',
    ...over,
  }
}

function msg(id: string, over: Record<string, unknown> = {}) {
  return {
    message_id: id,
    client_id: 'c1',
    conversation_id: null,
    body: `body ${id}`,
    direction: 'incoming',
    sender_name: 'Client',
    sender_phone: '+91 90000 00001',
    message_timestamp: '2026-11-17T06:00:00.000Z',
    created_at: '2026-11-17T06:00:05.000Z',
    ...over,
  }
}

function setup(tables: FakeTables = {}, opts: FakeOptions = UNIQUE) {
  const fake = createFakeSupabase(
    {
      settings: [],
      vas: [{ va_id: 'va1', va_name: 'Asha', whatsapp_number: '9000000009' }],
      clients: [],
      conversations: [],
      client_messages: [],
      document_uploads: [],
      follow_ups: [],
      ...tables,
    },
    opts,
  )
  const db = fake.client as unknown as SupabaseClient<Database>
  return { fake, db, store: supabaseFollowUpStore(db) }
}

describe('pilotClients', () => {
  it('returns council-enabled clients that are not inactive', async () => {
    const { store } = setup({
      clients: [
        { client_id: 'c1', client_name: 'Alpha', va_id: 'va1', council_enabled: true, status: 'Active' },
        { client_id: 'c2', client_name: 'Beta', va_id: null, council_enabled: true, status: null },
        { client_id: 'c3', client_name: 'Gamma', va_id: 'va1', council_enabled: true, status: 'Inactive' },
        { client_id: 'c4', client_name: 'Delta', va_id: 'va1', council_enabled: false, status: 'Active' },
      ],
    })
    expect(await store.pilotClients()).toEqual([
      { client_id: 'c1', client_name: 'Alpha', va_id: 'va1' },
      { client_id: 'c2', client_name: 'Beta', va_id: null },
    ])
  })
})

describe('watermark', () => {
  const empty = { version: 2, clients: {} }

  it('is empty when missing or malformed, and drops bad entries', async () => {
    expect(await setup().store.watermark()).toEqual(empty)
    expect(await setup({ settings: [{ key: WATERMARK_KEY, value: '{bad', note: null }] }).store.watermark()).toEqual(empty)
    expect(parseWatermark('[1,2]')).toEqual(empty)
    expect(parseWatermark(JSON.stringify({ version: 3, clients: {} }))).toEqual(empty)
    expect(parseWatermark(JSON.stringify({ version: 2, clients: [] }))).toEqual(empty)
  })

  it('reads the old shape { [clientId]: ISO } as both watermarks', () => {
    expect(parseWatermark(JSON.stringify({ c1: '2026-11-17T06:00:00Z', c2: 5, c3: 'nope' }))).toEqual({
      version: 2,
      clients: { c1: { messages: '2026-11-17T06:00:00Z', uploads: '2026-11-17T06:00:00Z' } },
    })
  })

  it('reads version 2 and drops bad fields', () => {
    const value = JSON.stringify({
      version: 2,
      clients: {
        c1: {
          messages: '2026-11-17T06:00:00Z',
          uploads: 'nope',
          seenUploads: { u1: '2026-11-17T05:00:00Z', u2: 7 },
          failures: { 'message:m1': 1, 'message:m2': -1, 'upload:u3': 'x' },
        },
        c2: 'bad',
      },
    })
    expect(parseWatermark(value)).toEqual({
      version: 2,
      clients: { c1: { messages: '2026-11-17T06:00:00Z', seenUploads: { u1: '2026-11-17T05:00:00Z' }, failures: { 'message:m1': 1 } } },
    })
  })

  it('saveWatermark inserts with a note, then updates in place', async () => {
    const { fake, store } = setup()
    const first = { version: 2 as const, clients: { c1: { messages: '2026-11-17T06:00:00Z' } } }
    await store.saveWatermark(first)
    expect(fake.tables.settings).toEqual([{ key: WATERMARK_KEY, value: JSON.stringify(first), note: 'Follow-ups scan watermark' }])
    const next = { version: 2 as const, clients: { c1: { messages: '2026-11-18T06:00:00Z' }, c2: { uploads: '2026-11-18T07:00:00Z' } } }
    await store.saveWatermark(next)
    expect(fake.tables.settings).toHaveLength(1)
    expect(await store.watermark()).toEqual(next)
  })
})

describe('newMessages', () => {
  const messages = [
    msg('m3', { created_at: '2026-11-17T08:00:00Z', message_timestamp: '2026-11-17T08:00:00Z' }),
    msg('m1', { created_at: '2026-11-17T06:00:00Z', message_timestamp: '2026-11-17T06:00:00Z', body: 'OTP is 445566' }),
    msg('m2', { created_at: '2026-11-17T07:00:00Z', message_timestamp: '2026-11-01T07:00:00Z', sender_phone: '9000000009' }),
    msg('m4', { client_id: 'c2', created_at: '2026-11-17T09:00:00Z' }),
  ]

  it('reads one client oldest first by created_at, masks bodies and derives the direction', async () => {
    const { store } = setup({ client_messages: messages })
    const out = await store.newMessages('c1', null, null, 10)
    expect(out.map((m) => m.message_id)).toEqual(['m1', 'm2', 'm3'])
    expect(out[0].body).toBe('OTP is [hidden]')
    expect(out[0].direction).toBe('incoming')
    expect(out[1].direction).toBe('outgoing') // team number, stored as incoming
    expect(out[1]).toMatchObject({ created_at: '2026-11-17T07:00:00Z', sender_phone: '9000000009', client_id: 'c1' })
  })

  it('applies after (created_at), since (message_timestamp) and limit', async () => {
    const { store } = setup({ client_messages: messages })
    expect((await store.newMessages('c1', '2026-11-17T06:00:00Z', null, 10)).map((m) => m.message_id)).toEqual(['m2', 'm3'])
    expect((await store.newMessages('c1', null, '2026-11-10T00:00:00Z', 10)).map((m) => m.message_id)).toEqual(['m1', 'm3'])
    expect((await store.newMessages('c1', null, null, 1)).map((m) => m.message_id)).toEqual(['m1'])
  })
})

describe('contextBefore', () => {
  it('returns the n messages before `at`, oldest first, masked', async () => {
    const { store } = setup({
      client_messages: [
        msg('a', { message_timestamp: '2026-11-17T01:00:00Z' }),
        msg('b', { message_timestamp: '2026-11-17T02:00:00Z', body: 'password: Secret123' }),
        msg('c', { message_timestamp: '2026-11-17T03:00:00Z' }),
        msg('d', { message_timestamp: '2026-11-17T04:00:00Z' }),
        msg('x', { client_id: 'c2', message_timestamp: '2026-11-17T03:30:00Z' }),
      ],
    })
    const out = await store.contextBefore('c1', '2026-11-17T04:00:00Z', 2)
    expect(out.map((m) => m.message_id)).toEqual(['b', 'c'])
    expect(out[0].body).toBe('password: [hidden]')
    expect(await store.contextBefore('c1', '2026-11-17T04:00:00Z', 0)).toEqual([])
  })
})

describe('newUploads', () => {
  it('reads one client oldest first after the watermark', async () => {
    const { store } = setup({
      document_uploads: [
        { upload_id: 'u2', client_id: 'c1', file_name: 'b.pdf', uploaded_at: '2026-11-17T08:00:00Z', sender_phone: null },
        { upload_id: 'u1', client_id: 'c1', file_name: null, uploaded_at: '2026-11-17T07:00:00Z', sender_phone: '9000000001' },
        { upload_id: 'u3', client_id: 'c2', file_name: 'c.pdf', uploaded_at: '2026-11-17T09:00:00Z', sender_phone: null },
      ],
    })
    expect(await store.newUploads('c1', null, 10)).toEqual([
      { upload_id: 'u1', file_name: '', uploaded_at: '2026-11-17T07:00:00Z', sender_phone: '9000000001' },
      { upload_id: 'u2', file_name: 'b.pdf', uploaded_at: '2026-11-17T08:00:00Z', sender_phone: null },
    ])
    expect((await store.newUploads('c1', '2026-11-17T07:00:00Z', 10)).map((u) => u.upload_id)).toEqual(['u2'])
    // The overlap read: (after, until].
    expect((await store.newUploads('c1', '2026-11-17T06:00:00Z', 10, '2026-11-17T07:00:00Z')).map((u) => u.upload_id)).toEqual(['u1'])
  })
})

describe('follow_ups rows', () => {
  it('open returns open and missed for the client, oldest first, with the source message time', async () => {
    const { store } = setup({
      client_messages: [msg('m1', { message_timestamp: '2026-11-16T06:00:00Z' })],
      follow_ups: [
        fu('f2', { status: 'missed', created_at: '2026-11-17T07:00:00Z' }),
        fu('f1', { created_at: '2026-11-17T06:00:00Z' }),
        fu('f3', { status: 'done' }),
        fu('f4', { client_id: 'c2' }),
      ],
    })
    const open = await store.open('c1')
    expect(open.map((r) => r.id)).toEqual(['f1', 'f2'])
    expect(open[0].source_at).toBe('2026-11-16T06:00:00Z')
    const gone = await setup({ follow_ups: [fu('f1', { source_message_id: 'gone' })] }).store.open('c1')
    expect(gone[0].source_at).toBeNull()
  })

  it('a missing follow_ups table (42P01) throws FollowUpsTableMissingError', async () => {
    const missing = { message: 'relation "public.follow_ups" does not exist', code: '42P01' }
    const { store } = setup({}, { fail: ({ table }) => (table === 'follow_ups' ? missing : null) })
    await expect(store.open('c1')).rejects.toBeInstanceOf(FollowUpsTableMissingError)
    await expect(store.alertCandidates('2026-11-18T13:30:00Z')).rejects.toBeInstanceOf(FollowUpsTableMissingError)
    await expect(
      store.insert({ client_id: 'c1', conversation_id: null, kind: 'document', source_message_id: 'm1', item: 'x', due_at: null }),
    ).rejects.toBeInstanceOf(FollowUpsTableMissingError)
    await expect(store.markEscalated('f1', '2026-11-18T05:00:00Z')).rejects.toBeInstanceOf(FollowUpsTableMissingError)
  })

  it('insert returns the row and null for a duplicate', async () => {
    const { fake, store } = setup()
    const row = { client_id: 'c1', conversation_id: null, kind: 'promise' as const, source_message_id: 'm1', item: 'MIS', due_at: null }
    expect(await store.insert(row)).toMatchObject(row)
    expect(await store.insert(row)).toBeNull()
    expect(fake.tables.follow_ups).toHaveLength(1)
  })

  it('insert throws other errors', async () => {
    const { store } = setup({}, { fail: ({ op }) => (op === 'insert' ? { message: 'boom', code: '23514' } : null) })
    await expect(
      store.insert({ client_id: 'c1', conversation_id: null, kind: 'document', source_message_id: 'm1', item: 'x', due_at: null }),
    ).rejects.toThrow('follow-ups insert: boom')
  })

  it('resolve closes an open item but never a closed one', async () => {
    const { fake, store } = setup({ follow_ups: [fu('f1'), fu('f2', { status: 'cancelled', resolved_by: 'asha@example.com' })] })
    await store.resolve('f1', { status: 'done', resolved_by: 'ai', resolved_upload_id: 'u1', at: '2026-11-18T06:00:00Z' })
    await store.resolve('f2', { status: 'done', resolved_by: 'ai', at: '2026-11-18T06:00:00Z' })
    expect(fake.tables.follow_ups[0]).toMatchObject({
      status: 'done',
      resolved_by: 'ai',
      resolved_at: '2026-11-18T06:00:00Z',
      resolved_message_id: null,
      resolved_upload_id: 'u1',
    })
    expect(fake.tables.follow_ups[1]).toMatchObject({ status: 'cancelled', resolved_by: 'asha@example.com' })
  })

  it('markReminded counts up, markEscalated sets its field, extend starts a new alert cycle, get reads', async () => {
    const { store } = setup({ follow_ups: [fu('f1', { status: 'missed' })] })
    await store.markReminded('f1', '2026-11-18T05:00:00Z')
    await store.markReminded('f1', '2026-11-18T07:00:00Z')
    await store.markEscalated('f1', '2026-11-18T08:00:00Z')
    expect(await store.get('f1')).toMatchObject({ reminder_count: 2, last_reminded_at: '2026-11-18T07:00:00Z', escalated_at: '2026-11-18T08:00:00Z' })
    await store.extend('f1', '2026-11-20T13:30:00.000Z')
    expect(await store.get('f1')).toMatchObject({
      reminder_count: 0,
      last_reminded_at: null,
      escalated_at: null,
      due_at: '2026-11-20T13:30:00.000Z',
      status: 'open',
    })
    expect(await store.get('nope')).toBeNull()
    expect(await store.get('')).toBeNull()
    await store.markReminded('nope', '2026-11-18T05:00:00Z') // no row: no error
  })

  it('get treats a malformed id as not found', async () => {
    const { store } = setup({}, { fail: () => ({ message: 'invalid input syntax for type uuid', code: '22P02' }) })
    expect(await store.get('not-a-uuid')).toBeNull()
  })
})

describe('alertCandidates', () => {
  it('returns items that may need an alert, once each, with the source time; finished ones are not read', async () => {
    const { store } = setup({
      client_messages: [msg('m1', { message_timestamp: '2026-11-10T06:00:00Z' })],
      follow_ups: [
        fu('due', { due_at: '2026-11-18T13:30:00.000Z' }),
        // An open promise is read even when escalated (history): it must still turn missed.
        fu('due-esc', { due_at: '2026-11-18T10:00:00.000Z', escalated_at: '2026-11-17T07:00:00Z' }),
        fu('missed', { status: 'missed', due_at: '2026-11-17T13:30:00.000Z' }),
        fu('missed-esc', { status: 'missed', due_at: '2026-11-17T13:30:00.000Z', escalated_at: '2026-11-17T14:00:00Z' }),
        fu('doc', { kind: 'document', due_at: '2026-11-18T13:30:00.000Z', reminder_count: 2 }),
        fu('doc-esc', { kind: 'document', due_at: '2026-11-16T13:30:00.000Z', reminder_count: 3, escalated_at: '2026-11-17T07:00:00Z' }),
        fu('doc-later', { kind: 'document', due_at: '2026-11-25T13:30:00.000Z' }),
        fu('later', { due_at: '2026-11-25T13:30:00.000Z' }),
        fu('done', { status: 'done' }),
        fu('nodue', { kind: 'document', due_at: null }),
        fu('rep', { kind: 'repeat_ask', due_at: null, source_message_id: 'gone' }),
        fu('rep-esc', { kind: 'repeat_ask', due_at: null, escalated_at: '2026-11-17T07:00:00Z' }),
        fu('rep-missed', { kind: 'repeat_ask', status: 'missed', due_at: null }),
        fu('rep-due', { kind: 'repeat_ask', due_at: '2026-11-18T05:00:00.000Z' }),
      ],
    })
    const out = await store.alertCandidates('2026-11-18T13:30:00.000Z')
    expect(out.map((r) => r.id).sort()).toEqual(['doc', 'due', 'due-esc', 'missed', 'rep', 'rep-due'])
    expect(out.find((r) => r.id === 'due')?.source_at).toBe('2026-11-10T06:00:00Z')
    // Source message missing: falls back to created_at.
    expect(out.find((r) => r.id === 'rep')?.source_at).toBe('2026-11-17T06:00:00.000Z')
  })
})

describe('followUpViews', () => {
  const tables = (): FakeTables => ({
    clients: [
      { client_id: 'c1', client_name: 'Alpha', va_id: 'va1' },
      { client_id: 'c2', client_name: 'Beta', va_id: 'va1' },
    ],
    vas: [
      { va_id: 'va1', va_name: 'Asha' },
      { va_id: 'va2', va_name: 'Ravi' },
    ],
    conversations: [
      { id: 't1', client_id: 'c1', va_id: 'va2' },
      { id: 't2', client_id: 'c2', va_id: null },
    ],
    client_messages: [msg('m1', { message_timestamp: '2026-11-16T06:00:00Z', sender_name: 'Rahul' })],
    follow_ups: [
      fu('f1', { conversation_id: 't1', item: 'Send the OTP is 556677 screenshot' }),
      fu('f2', { client_id: 'c2', conversation_id: 't2', source_message_id: 'missing' }),
      fu('f3', { client_id: 'c2' }),
    ],
  })

  it('joins client, accountant (ticket first, else client) and source message, in the order asked', async () => {
    const { db } = setup(tables())
    const out = await followUpViews(['f3', 'f1', 'nope', 'f2'], db)
    expect(out.map((v) => v.id)).toEqual(['f3', 'f1', 'f2'])
    expect(out[1]).toEqual({
      id: 'f1',
      clientId: 'c1',
      clientName: 'Alpha',
      kind: 'promise',
      item: 'Send the OTP is [hidden] screenshot',
      status: 'open',
      dueAt: '2026-11-18T13:30:00.000Z',
      createdAt: '2026-11-17T06:00:00.000Z',
      sourceAt: '2026-11-16T06:00:00Z',
      sourceSender: 'Rahul',
      vaId: 'va2',
      vaName: 'Ravi',
      conversationId: 't1',
      reminderCount: 0,
      resolvedAt: null,
      resolvedBy: null,
    })
    // Ticket without an accountant: the client's accountant. Missing source: created_at, no sender.
    expect(out[2]).toMatchObject({ vaId: 'va1', vaName: 'Asha', sourceAt: '2026-11-17T06:00:00.000Z', sourceSender: null })
    expect(out[0]).toMatchObject({ clientName: 'Beta', vaId: 'va1', conversationId: null })
  })

  it('returns [] for no ids', async () => {
    const { db, fake } = setup(tables())
    expect(await followUpViews([], db)).toEqual([])
    expect(fake.calls.filter((c) => c.table !== 'follow_ups')).toHaveLength(0)
  })
})
