import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyViewAs, ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'
import type { FollowUpRow } from '@/lib/followups/types'
import { createFakeSupabase, type FakeTables } from './testing/fake-supabase'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import { followUpAction, listDueFollowUps, listFollowUps } from './index'
import { isHistoryItem } from './followups'

const asha: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const admin: AppUser = { id: 'u2', email: 'admin@example.com', name: 'Admin', role: 'admin', vaId: null }
const engineer: AppUser = { id: 'u3', email: 'eng@example.com', name: 'Eng', role: 'engineer', vaId: null }

// Wednesday 18 Nov 2026, 12:00 IST.
const NOW = new Date('2026-11-18T06:30:00.000Z')

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

function fixtures(): FakeTables {
  return {
    vas: [
      { va_id: 'va1', va_name: 'Asha', email: 'asha@example.com' },
      { va_id: 'va2', va_name: 'Ravi', email: 'ravi@example.com' },
    ],
    clients: [
      { client_id: 'c1', client_name: 'Alpha', va_id: 'va1' },
      { client_id: 'c2', client_name: 'Beta', va_id: 'va2' },
    ],
    conversations: [],
    client_messages: [
      { message_id: 'm1', client_id: 'c1', message_timestamp: '2026-11-17T05:59:00.000Z', sender_name: 'Asha' },
    ],
    follow_ups: [
      fu('a-old', { created_at: '2026-11-10T06:00:00.000Z', due_at: '2026-11-12T13:30:00.000Z', status: 'missed' }),
      fu('a-new', { created_at: '2026-11-17T08:00:00.000Z', kind: 'document', due_at: '2026-11-19T13:30:00.000Z' }),
      fu('a-done', { created_at: '2026-11-16T08:00:00.000Z', status: 'done', resolved_by: 'ai' }),
      fu('a-rep', { created_at: '2026-11-15T08:00:00.000Z', kind: 'repeat_ask', due_at: null }),
      fu('a-late', { created_at: '2026-11-14T08:00:00.000Z', due_at: '2026-11-18T17:00:00.000Z' }), // 22:30 IST today
      fu('a-tomorrow', { created_at: '2026-11-14T09:00:00.000Z', due_at: '2026-11-18T18:30:00.000Z' }), // 00:00 IST 19th
      fu('b-due', { client_id: 'c2', created_at: '2026-11-11T06:00:00.000Z', due_at: '2026-11-11T13:30:00.000Z' }),
      fu('b-cancel', { client_id: 'c2', status: 'cancelled', due_at: '2026-11-01T13:30:00.000Z' }),
    ],
  }
}

let fake: ReturnType<typeof createFakeSupabase>
beforeEach(() => {
  fake = createFakeSupabase(fixtures())
  state.db = fake.client
})

const updates = () => fake.calls.filter((c) => c.table === 'follow_ups' && c.op === 'update')
const row = (id: string) => fake.tables.follow_ups.find((r) => r.id === id)

describe('listFollowUps', () => {
  it('open (default) is open + missed, newest first, with names', async () => {
    const out = await listFollowUps(asha, 'c1')
    expect(out.map((v) => v.id)).toEqual(['a-new', 'a-rep', 'a-tomorrow', 'a-late', 'a-old'])
    expect(out[0]).toMatchObject({ clientName: 'Alpha', vaId: 'va1', vaName: 'Asha', sourceSender: 'Asha' })
  })

  it('all includes closed items, and limit applies', async () => {
    expect((await listFollowUps(asha, 'c1', { status: 'all' })).map((v) => v.id)).toContain('a-done')
    expect(await listFollowUps(asha, 'c1', { status: 'all', limit: 2 })).toHaveLength(2)
  })

  it('a senior accountant gets [] for another accountant client; admin and engineer see it', async () => {
    expect(await listFollowUps(asha, 'c2')).toEqual([])
    expect((await listFollowUps(admin, 'c2')).map((v) => v.id)).toEqual(['b-due'])
    expect((await listFollowUps(engineer, 'c2')).map((v) => v.id)).toEqual(['b-due'])
    expect(await listFollowUps(admin, 'nope')).toEqual([])
  })

  it('view as is scoped to the target accountant', async () => {
    const viewing = applyViewAs(engineer, { va_id: 'va2', va_name: 'Ravi', email: 'ravi@example.com' })
    expect(await listFollowUps(viewing, 'c1')).toEqual([])
    expect((await listFollowUps(viewing, 'c2')).map((v) => v.id)).toEqual(['b-due'])
  })
})

describe('listDueFollowUps', () => {
  it('due by the end of today IST or a repeat ask, most overdue first, own clients only', async () => {
    const out = await listDueFollowUps(asha, { now: NOW })
    // a-tomorrow (00:00 IST on the 19th) and a-new (19th) are not due yet; a-done is closed.
    expect(out.map((v) => v.id)).toEqual(['a-old', 'a-rep', 'a-late'])
  })

  it('admin and engineer see every client', async () => {
    expect((await listDueFollowUps(admin, { now: NOW })).map((v) => v.id)).toEqual(['b-due', 'a-old', 'a-rep', 'a-late'])
    expect((await listDueFollowUps(engineer, { now: NOW, limit: 2 })).map((v) => v.id)).toEqual(['b-due', 'a-old'])
  })

  it('a senior accountant without an accountant record sees nothing', async () => {
    expect(await listDueFollowUps({ ...asha, vaId: null }, { now: NOW })).toEqual([])
  })

  it('leaves out items found while scanning old messages (created over 24 h after the message)', async () => {
    fake.tables.client_messages.push(
      { message_id: 'm-old', client_id: 'c1', message_timestamp: '2026-10-25T06:00:00.000Z', sender_name: 'Asha' },
      { message_id: 'm-edge', client_id: 'c1', message_timestamp: '2026-11-16T06:00:00.000Z', sender_name: 'Asha' },
    )
    fake.tables.follow_ups.push(
      // Backfill: message 25 Oct, found 17 Nov. Most overdue, so it would lead the list.
      fu('a-hist', { source_message_id: 'm-old', due_at: '2026-10-27T13:30:00.000Z', status: 'missed' }),
      fu('a-hist-rep', { source_message_id: 'm-old', kind: 'repeat_ask', due_at: null }),
      // Exactly 24 h after the message is still live.
      fu('a-edge', { source_message_id: 'm-edge', created_at: '2026-11-17T06:00:00.000Z', due_at: '2026-11-10T13:30:00.000Z' }),
    )
    expect((await listDueFollowUps(asha, { now: NOW })).map((v) => v.id)).toEqual(['a-edge', 'a-old', 'a-rep', 'a-late'])
    // The limit counts only what is shown.
    expect((await listDueFollowUps(asha, { now: NOW, limit: 2 })).map((v) => v.id)).toEqual(['a-edge', 'a-old'])
    // The client page still lists them.
    expect((await listFollowUps(asha, 'c1')).map((v) => v.id)).toEqual(expect.arrayContaining(['a-hist', 'a-hist-rep']))
  })
})

describe('isHistoryItem', () => {
  it('is true only when created more than 24 h after the source message', () => {
    expect(isHistoryItem({ sourceAt: '2026-11-01T00:00:00.000Z', createdAt: '2026-11-02T00:00:00.001Z' })).toBe(true)
    expect(isHistoryItem({ sourceAt: '2026-11-01T00:00:00.000Z', createdAt: '2026-11-02T00:00:00.000Z' })).toBe(false)
    expect(isHistoryItem({ sourceAt: '2026-11-01T00:00:00.000Z', createdAt: '2026-11-01T00:15:00.000Z' })).toBe(false)
    expect(isHistoryItem({ sourceAt: 'bad', createdAt: '2026-11-02T00:00:00.000Z' })).toBe(false)
  })
})

describe('followUpAction', () => {
  it('done closes with the user and time', async () => {
    const view = await followUpAction(asha, 'a-late', 'done', NOW)
    expect(view).toMatchObject({ id: 'a-late', status: 'done', resolvedBy: 'asha@example.com', resolvedAt: NOW.toISOString() })
    expect(row('a-late')).toMatchObject({ status: 'done', resolved_by: 'asha@example.com', resolved_at: NOW.toISOString() })
  })

  it('cancel works on a missed item, and admin can act on any client', async () => {
    expect((await followUpAction(asha, 'a-old', 'cancel', NOW)).status).toBe('cancelled')
    expect((await followUpAction(admin, 'b-due', 'done', NOW)).resolvedBy).toBe('admin@example.com')
  })

  it('extend from a past deadline: next business day after now, 19:00 IST, reopened', async () => {
    const view = await followUpAction(asha, 'a-old', 'extend', NOW)
    expect(view).toMatchObject({ status: 'open', dueAt: '2026-11-19T13:30:00.000Z' })
  })

  it('extend on an escalated promise clears its alert state so it can remind and escalate again', async () => {
    fake.tables.follow_ups.push(
      fu('a-esc', {
        status: 'missed',
        due_at: '2026-11-17T13:30:00.000Z',
        reminder_count: 1,
        last_reminded_at: '2026-11-17T04:00:00.000Z',
        escalated_at: '2026-11-17T14:00:00.000Z',
      }),
    )
    const view = await followUpAction(asha, 'a-esc', 'extend', NOW)
    expect(view).toMatchObject({ status: 'open', dueAt: '2026-11-19T13:30:00.000Z', reminderCount: 0 })
    expect(row('a-esc')).toMatchObject({ status: 'open', escalated_at: null, reminder_count: 0 })
    // A promise keeps last_reminded_at (only documents use it, for the chase gap).
    expect(row('a-esc')?.last_reminded_at).toBe('2026-11-17T04:00:00.000Z')
  })

  it('extend on a chased document starts a fresh chase cycle', async () => {
    fake.tables.follow_ups.push(
      fu('a-chased', {
        kind: 'document',
        due_at: '2026-11-16T13:30:00.000Z',
        reminder_count: 3,
        last_reminded_at: '2026-11-17T05:00:00.000Z',
        escalated_at: '2026-11-18T04:00:00.000Z',
      }),
    )
    await followUpAction(asha, 'a-chased', 'extend', NOW)
    expect(row('a-chased')).toMatchObject({
      status: 'open',
      due_at: '2026-11-19T13:30:00.000Z',
      reminder_count: 0,
      last_reminded_at: null,
      escalated_at: null,
    })
  })

  it('done and cancel leave the alert state alone', async () => {
    fake.tables.follow_ups.push(fu('a-rem', { reminder_count: 2, escalated_at: '2026-11-18T04:00:00.000Z' }))
    await followUpAction(asha, 'a-rem', 'done', NOW)
    expect(row('a-rem')).toMatchObject({ reminder_count: 2, escalated_at: '2026-11-18T04:00:00.000Z' })
  })

  it('extend from a future deadline: next business day after it (Saturday to Monday)', async () => {
    fake.tables.follow_ups.push(fu('a-sat', { kind: 'document', due_at: '2026-11-21T13:30:00.000Z' }))
    expect((await followUpAction(asha, 'a-sat', 'extend', NOW)).dueAt).toBe('2026-11-23T13:30:00.000Z')
    expect((await followUpAction(asha, 'a-new', 'extend', NOW)).dueAt).toBe('2026-11-20T13:30:00.000Z')
  })

  it('extend with no deadline counts from now', async () => {
    fake.tables.follow_ups.push(fu('a-nodue', { kind: 'document', due_at: null }))
    expect((await followUpAction(asha, 'a-nodue', 'extend', NOW)).dueAt).toBe('2026-11-19T13:30:00.000Z')
  })

  it('a repeat ask cannot be extended', async () => {
    await expect(followUpAction(asha, 'a-rep', 'extend', NOW)).rejects.toThrow(
      'Only promises and document requests can be extended.',
    )
    expect(updates()).toHaveLength(0)
  })

  it('a closed item cannot be changed', async () => {
    await expect(followUpAction(asha, 'a-done', 'done', NOW)).rejects.toThrow('This follow-up is already closed.')
    await expect(followUpAction(admin, 'b-cancel', 'extend', NOW)).rejects.toThrow('This follow-up is already closed.')
    expect(updates()).toHaveLength(0)
  })

  it('a follow-up that does not exist', async () => {
    await expect(followUpAction(asha, 'nope', 'done', NOW)).rejects.toThrow('Follow-up not found.')
    await expect(followUpAction(asha, '', 'done', NOW)).rejects.toThrow('Follow-up not found.')
  })

  it('another accountant client is forbidden', async () => {
    await expect(followUpAction(asha, 'b-due', 'done', NOW)).rejects.toBeInstanceOf(ForbiddenError)
    expect(updates()).toHaveLength(0)
  })

  it('engineers cannot act, and view as is read only', async () => {
    await expect(followUpAction(engineer, 'a-late', 'done', NOW)).rejects.toBeInstanceOf(ForbiddenError)
    const viewing = applyViewAs(engineer, { va_id: 'va1', va_name: 'Asha', email: 'asha@example.com' })
    await expect(followUpAction(viewing, 'a-late', 'done', NOW)).rejects.toBeInstanceOf(ViewAsReadOnlyError)
    expect(updates()).toHaveLength(0)
  })
})
