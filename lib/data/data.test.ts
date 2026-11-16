import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyViewAs, ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'
import { clearTeamNumbersCache, getTeamNumbers } from '@/lib/team'
import { createFakeSupabase, type FakeTables } from './testing/fake-supabase'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import {
  assignClient,
  getClient,
  getClientScores,
  getScoreHistory,
  getCouncilUsage,
  getSystemHealth,
  getTeamOverview,
  getTimeline,
  listClients,
  listConversations,
  listDocuments,
  listMeetings,
  listMessages,
  listRecentActivity,
  listVas,
  retryProcessing,
  setCouncilEnabled,
  updateConversation,
} from './index'
import { buildConversationUpdate } from './conversations'
import { fetchAll } from './paginate'

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

function fixtures(): FakeTables {
  return {
    vas: [
      { va_id: 'va1', va_name: 'Asha', email: 'asha@example.com', status: 'active', whatsapp_number: '+91 90000 00001' },
      { va_id: 'va2', va_name: 'Ravi', email: 'ravi@example.com', status: 'active', whatsapp_number: null },
    ],
    settings: [{ key: 'team_whatsapp_numbers', value: '919000000009', note: null }],
    clients: [
      { client_id: 'c1', client_name: 'Alpha Traders', legal_name: 'Alpha Traders LLP', va_id: 'va1', status: 'active', deal_stage: null, whatsapp_group_name: 'Alpha x AIA', council_enabled: true, parent_client_id: null, email: null, gstin: '29ABCDE1234F1Z5', entity_type: null, industry: null, city: null, state: null, onboarding_date: null, hubspot_deal_id: null, whatsapp_group_id: 'g1' },
      { client_id: 'c2', client_name: 'Beta Foods', legal_name: null, va_id: 'va2', status: 'active', deal_stage: null, whatsapp_group_name: null, council_enabled: false, parent_client_id: null, email: null, gstin: null, entity_type: null, industry: null, city: null, state: null, onboarding_date: null, hubspot_deal_id: null, whatsapp_group_id: null },
      { client_id: 'c3', client_name: 'Gamma Labs', legal_name: null, va_id: null, status: 'active', deal_stage: null, whatsapp_group_name: null, council_enabled: false, parent_client_id: null, email: null, gstin: null, entity_type: null, industry: null, city: null, state: null, onboarding_date: null, hubspot_deal_id: null, whatsapp_group_id: null },
    ],
    client_scores: [
      { client_id: 'c1', va_id: 'va1', service_score: 80, mood_score: 70, service_delta: 2, mood_delta: -1, open_issues: 1, complaints_7d: 0, our_fault_7d: 0, unanswered_count: 1, worst_lag_minutes: 30, top_reasons: ['Slow reply', 3], computed_at: hoursAgo(5), last_message_at: hoursAgo(1) },
      { client_id: 'c2', va_id: 'va2', service_score: 40, mood_score: 50, service_delta: null, mood_delta: null, open_issues: 2, complaints_7d: 1, our_fault_7d: 1, unanswered_count: 0, worst_lag_minutes: 900, top_reasons: [], computed_at: hoursAgo(4), last_message_at: hoursAgo(2) },
    ],
    client_score_history: [
      { client_id: 'c1', score_date: hoursAgo(48).slice(0, 10), service_score: 78, mood_score: 70, open_issues: 1, complaints_7d: 0, our_fault_7d: 0, computed_at: hoursAgo(48) },
      { client_id: 'c1', score_date: hoursAgo(24 * 400).slice(0, 10), service_score: 50, mood_score: 50, open_issues: 0, complaints_7d: 0, our_fault_7d: 0, computed_at: hoursAgo(24 * 400) },
      { client_id: 'c2', score_date: hoursAgo(48).slice(0, 10), service_score: 40, mood_score: 50, open_issues: 0, complaints_7d: 0, our_fault_7d: 0, computed_at: hoursAgo(48) },
    ],
    conversations: [
      { id: 't1', client_id: 'c1', va_id: 'va1', title: 'GST filing query', summary: 'Client asked about GSTR-3B', status: 'open', tag: 'escalation', fault: null, client_tone: null, va_tone: null, sla_breached: true, opened_at: hoursAgo(3), opened_by: 'council', closed_at: null, last_message_at: hoursAgo(1), last_message_direction: 'incoming', message_count: 3, updated_at: hoursAgo(1) },
      { id: 't2', client_id: 'c2', va_id: 'va2', title: null, summary: 'Payment reminder', status: 'open', tag: 'complaint', fault: 'us', client_tone: null, va_tone: null, sla_breached: false, opened_at: hoursAgo(50), opened_by: 'council', closed_at: null, last_message_at: hoursAgo(2), last_message_direction: 'outgoing', message_count: 2, updated_at: hoursAgo(2) },
      { id: 't3', client_id: 'c1', va_id: 'va1', title: 'Bank statement', summary: 'Shared', status: 'closed', tag: 'neutral', fault: null, client_tone: null, va_tone: null, sla_breached: false, opened_at: hoursAgo(100), opened_by: 'council', closed_at: hoursAgo(10), last_message_at: hoursAgo(10), last_message_direction: 'outgoing', message_count: 4, updated_at: hoursAgo(10) },
    ],
    client_messages: [
      { message_id: 'm1', dedup_hash: 'AAA1', client_id: 'c1', message_timestamp: hoursAgo(3), body: 'Please file GST', sender_name: 'Client A', sender_phone: '918888888888', direction: 'incoming', message_type: 'chat', conversation_id: 't1' },
      { message_id: 'm2', dedup_hash: 'AAA2', client_id: 'c1', message_timestamp: hoursAgo(2), body: 'Done, sharing the challan', sender_name: 'Team member', sender_phone: '919000000009', direction: 'incoming', message_type: 'chat', conversation_id: 't1' },
      { message_id: 'm3', dedup_hash: 'AAA3', client_id: 'c1', message_timestamp: hoursAgo(1), body: 'Thanks', sender_name: 'Client A', sender_phone: '918888888888', direction: null, message_type: 'chat', conversation_id: 't1' },
      { message_id: 'm4', dedup_hash: 'BBB1', client_id: 'c2', message_timestamp: hoursAgo(2), body: 'Beta secret', sender_name: 'Client B', sender_phone: '917777777777', direction: 'incoming', message_type: 'chat', conversation_id: 't2' },
    ],
    document_uploads: [
      { upload_id: 'd1', client_id: 'c1', client_name: 'Alpha Traders', file_name: 'invoice.pdf', folder_name: 'Client Files/Alpha/', file_type: 'pdf', file_size: 1200, uploaded_at: hoursAgo(4), group_name: 'Alpha x AIA', sender_phone: '918888888888', group_id: 'g1', notified: true },
      { upload_id: 'd2', client_id: 'c2', client_name: 'Beta Foods', file_name: 'beta.pdf', folder_name: 'Client Files/Beta', file_type: 'pdf', file_size: 100, uploaded_at: hoursAgo(4), group_name: null, sender_phone: null, group_id: null, notified: null },
    ],
    va_meeting_transcripts: [
      { id: 'mt1', client_id: 'c1', subject: '[Alpha] - monthly review', meeting_start: hoursAgo(6), meeting_end: hoursAgo(5), meeting_date: null, meeting_duration_minutes: 60, organizer_name: 'Asha', poc_name: 'Client A', meeting_type: 'teams', transcript_status: 'done', teams_url: 'https://teams.example.com/m1', transcript: 'hello' },
    ],
    client_contacts: [
      { contact_id: 'k1', client_id: 'c1', contact_name: 'Zed', role: 'accounts', whatsapp_number: '918888888887', is_primary: false },
      { contact_id: 'k2', client_id: 'c1', contact_name: 'Amit', role: 'owner', whatsapp_number: '918888888888', is_primary: true },
      { contact_id: 'k3', client_id: 'c2', contact_name: 'Bina', role: 'owner', whatsapp_number: '917777777777', is_primary: true },
    ],
    message_processing_log: [
      { message_id: 'm1', status: 'failed', error: 'timeout', attempts: 3, max_attempts: 3, created_at: hoursAgo(3), processed_at: null },
      { message_id: 'm2', status: 'done', error: null, attempts: 1, max_attempts: 3, created_at: hoursAgo(2), processed_at: hoursAgo(2) },
    ],
  }
}

const acc1: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const accNoVa: AppUser = { id: 'u0', email: 'x@example.com', name: 'X', role: 'senior_accountant', vaId: null }
const admin: AppUser = { id: 'u2', email: 'admin@example.com', name: 'Admin', role: 'admin', vaId: null }
const engineer: AppUser = { id: 'u3', email: 'eng@example.com', name: 'Eng', role: 'engineer', vaId: null }
const viewAsRavi = applyViewAs(engineer, { va_id: 'va2', va_name: 'Ravi', email: 'ravi@example.com' })
// Defensive: a user object with viewingAs but the engineer role kept.
const viewAsRaw: AppUser = { ...engineer, viewingAs: { vaId: 'va2', name: 'Ravi' } }

let fake: ReturnType<typeof createFakeSupabase>

beforeEach(() => {
  fake = createFakeSupabase(fixtures())
  state.db = fake.client
  clearTeamNumbersCache()
})

describe('team numbers', () => {
  it('merges vas numbers and the settings row', async () => {
    expect([...(await getTeamNumbers())].sort()).toEqual(['9000000001', '9000000009'])
  })
  it('caches within the TTL', async () => {
    await getTeamNumbers()
    await getTeamNumbers()
    expect(fake.calls.filter((c) => c.table === 'vas').length).toBe(1)
  })
})

describe('listClients scope', () => {
  it('gives a senior accountant only their clients, with score and ticket counts', async () => {
    const list = await listClients(acc1)
    expect(list.map((c) => c.id)).toEqual(['c1'])
    expect(list[0]).toMatchObject({ vaName: 'Asha', serviceScore: 80, openTickets: 1, openEscalations: 1, unansweredCount: 1 })
  })
  it('reads last message time live from client_messages, not from the stored score', async () => {
    const all = await listClients(admin)
    const byId = new Map(all.map((c) => [c.id, c]))
    expect(byId.get('c1')?.lastMessageAt).toBe(fake.tables.client_messages[2].message_timestamp)
    expect(byId.get('c2')?.lastMessageAt).toBe(fake.tables.client_messages[3].message_timestamp)
    expect(byId.get('c3')?.lastMessageAt).toBeNull()
  })
  it('gives admin and engineer every client, sorted by name', async () => {
    expect((await listClients(admin)).map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect((await listClients(engineer)).map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })
  it('lets admin filter by accountant and search', async () => {
    expect((await listClients(admin, { vaId: 'va2' })).map((c) => c.id)).toEqual(['c2'])
    expect((await listClients(admin, { search: 'alpha x' })).map((c) => c.id)).toEqual(['c1'])
    expect((await listClients(admin, { search: 'LLP' })).map((c) => c.id)).toEqual(['c1'])
  })
  it('ignores a vaId filter that would widen an accountant scope', async () => {
    expect(await listClients(acc1, { vaId: 'va2' })).toEqual([])
  })
  it('returns nothing for an accountant with no vas mapping', async () => {
    expect(await listClients(accNoVa)).toEqual([])
  })
  it('scopes view as to the viewed accountant', async () => {
    expect((await listClients(viewAsRavi)).map((c) => c.id)).toEqual(['c2'])
    expect((await listClients(viewAsRaw)).map((c) => c.id)).toEqual(['c2'])
  })
  it('handles unscored clients', async () => {
    const c3 = (await listClients(admin)).find((c) => c.id === 'c3')
    expect(c3).toMatchObject({ serviceScore: null, vaName: null, openTickets: 0 })
  })
})

describe('getClient', () => {
  it('returns null outside scope', async () => {
    expect(await getClient(acc1, 'c2')).toBeNull()
    expect(await getClient(accNoVa, 'c1')).toBeNull()
    expect(await getClient(acc1, 'nope')).toBeNull()
  })
  it('includes contacts (primary first), accountant name and reasons', async () => {
    const c = await getClient(acc1, 'c1')
    expect(c?.vaName).toBe('Asha')
    expect(c?.contacts.map((k) => k.id)).toEqual(['k2', 'k1'])
    expect(c?.topReasons).toEqual(['Slow reply'])
    expect(c?.gstin).toBe('29ABCDE1234F1Z5')
  })
})

describe('listMessages', () => {
  it('returns [] outside scope', async () => {
    expect(await listMessages(acc1, 'c2')).toEqual([])
    expect(await listMessages(viewAsRavi, 'c1')).toEqual([])
  })
  it('uses the effective direction and returns oldest first', async () => {
    const msgs = await listMessages(acc1, 'c1')
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(msgs.map((m) => m.direction)).toEqual(['incoming', 'outgoing', 'incoming'])
    expect(msgs[1]).toMatchObject({ fromTeam: true, storedDirection: 'incoming', waMessageId: 'AAA2' })
  })
  it('pages with before and limit', async () => {
    const page = await listMessages(acc1, 'c1', { limit: 2 })
    expect(page.map((m) => m.id)).toEqual(['m2', 'm3'])
    const older = await listMessages(acc1, 'c1', { before: page[0].at, limit: 2 })
    expect(older.map((m) => m.id)).toEqual(['m1'])
    expect(await listMessages(acc1, 'c1', { before: 'not a date' })).toEqual([])
  })
})

describe('listConversations', () => {
  it('scopes tickets by the client accountant', async () => {
    expect((await listConversations(acc1)).map((t) => t.id)).toEqual(['t1', 't3'])
    expect((await listConversations(admin)).map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(await listConversations(accNoVa)).toEqual([])
  })
  it('filters by status, tag and client', async () => {
    expect((await listConversations(acc1, { status: 'open' })).map((t) => t.id)).toEqual(['t1'])
    expect((await listConversations(admin, { tag: 'complaint' })).map((t) => t.id)).toEqual(['t2'])
    expect(await listConversations(acc1, { clientId: 'c2' })).toEqual([])
    const t = await listConversations(acc1, { clientId: 'c1', status: 'open' })
    expect(t[0]).toMatchObject({ id: 't1', clientName: 'Alpha Traders', slaBreached: true })
  })
})

describe('updateConversation', () => {
  it('lets an accountant close their own ticket', async () => {
    await updateConversation(acc1, 't1', { status: 'closed', summary: 'Filed' })
    const row = fake.tables.conversations.find((r) => r.id === 't1')
    expect(row).toMatchObject({ status: 'closed', summary: 'Filed' })
    expect(typeof row?.closed_at).toBe('string')
  })
  it('rejects tickets of other accountants', async () => {
    await expect(updateConversation(acc1, 't2', { status: 'closed' })).rejects.toBeInstanceOf(ForbiddenError)
    expect(fake.tables.conversations.find((r) => r.id === 't2')?.status).toBe('open')
  })
  it('rejects view as and the engineer role', async () => {
    await expect(updateConversation(viewAsRavi, 't2', { status: 'closed' })).rejects.toBeInstanceOf(ViewAsReadOnlyError)
    await expect(updateConversation(viewAsRaw, 't2', { status: 'closed' })).rejects.toBeInstanceOf(ViewAsReadOnlyError)
    await expect(updateConversation(engineer, 't2', { status: 'closed' })).rejects.toBeInstanceOf(ForbiddenError)
  })
  it('lets admin update any ticket and reopen it', async () => {
    await updateConversation(admin, 't3', { status: 'open', tag: 'complaint' })
    expect(fake.tables.conversations.find((r) => r.id === 't3')).toMatchObject({ status: 'open', closed_at: null, tag: 'complaint' })
  })
  it('validates the patch and the id', async () => {
    await expect(updateConversation(admin, 't1', { status: 'pending' as 'open' })).rejects.toThrow()
    await expect(updateConversation(admin, 'missing', { status: 'closed' })).rejects.toThrow('Ticket not found.')
  })
})

describe('buildConversationUpdate', () => {
  const now = new Date('2026-11-16T05:00:00Z')
  it('returns null for an empty patch', () => {
    expect(buildConversationUpdate({}, now)).toBeNull()
  })
  it('sets closed_at on close and trims text', () => {
    expect(buildConversationUpdate({ status: 'closed', title: '  New title ' }, now)).toEqual({
      status: 'closed',
      closed_at: now.toISOString(),
      title: 'New title',
      updated_at: now.toISOString(),
    })
  })
  it('rejects unknown keys', () => {
    expect(() => buildConversationUpdate({ va_id: 'x' } as never, now)).toThrow()
  })
})

describe('admin and engineer mutations', () => {
  it('assignClient: admin only, not view as', async () => {
    await assignClient(admin, 'c3', 'va2')
    expect(fake.tables.clients.find((c) => c.client_id === 'c3')?.va_id).toBe('va2')
    await expect(assignClient(acc1, 'c1', 'va2')).rejects.toBeInstanceOf(ForbiddenError)
    await expect(assignClient(engineer, 'c1', 'va2')).rejects.toBeInstanceOf(ForbiddenError)
    await expect(assignClient(viewAsRavi, 'c1', 'va2')).rejects.toBeInstanceOf(ViewAsReadOnlyError)
    await expect(assignClient(admin, 'c1', 'nobody')).rejects.toThrow('Accountant not found.')
    await expect(assignClient(admin, 'missing', 'va1')).rejects.toThrow('Client not found.')
    expect(fake.tables.clients.find((c) => c.client_id === 'c1')?.va_id).toBe('va1')
  })
  it('setCouncilEnabled: engineer only, not view as', async () => {
    await setCouncilEnabled(engineer, 'c2', true)
    expect(fake.tables.clients.find((c) => c.client_id === 'c2')?.council_enabled).toBe(true)
    await expect(setCouncilEnabled(admin, 'c2', false)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(setCouncilEnabled(acc1, 'c1', false)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(setCouncilEnabled(viewAsRavi, 'c2', false)).rejects.toBeInstanceOf(ViewAsReadOnlyError)
    await expect(setCouncilEnabled(engineer, 'missing', true)).rejects.toThrow('Client not found.')
  })
  it('retryProcessing: engineer only, sets status back to pending', async () => {
    await retryProcessing(engineer, 'm1')
    expect(fake.tables.message_processing_log.find((r) => r.message_id === 'm1')).toMatchObject({ status: 'pending', attempts: 3 })
    await expect(retryProcessing(admin, 'm1')).rejects.toBeInstanceOf(ForbiddenError)
    await expect(retryProcessing(viewAsRaw, 'm1')).rejects.toBeInstanceOf(ViewAsReadOnlyError)
    await expect(retryProcessing(engineer, 'missing')).rejects.toThrow('Processing record not found.')
  })
})

describe('scores', () => {
  it('scopes current scores', async () => {
    expect((await getClientScores(acc1)).map((s) => s.clientId)).toEqual(['c1'])
    expect((await getClientScores(acc1, ['c1', 'c2'])).map((s) => s.clientId)).toEqual(['c1'])
    expect((await getClientScores(admin)).map((s) => s.clientId)).toEqual(['c1', 'c2'])
    expect(await getClientScores(accNoVa)).toEqual([])
  })
  it('returns history within the window only, in scope only', async () => {
    expect((await getScoreHistory(acc1, 'c1', 30)).map((h) => h.serviceScore)).toEqual([78])
    expect(await getScoreHistory(acc1, 'c2', 30)).toEqual([])
  })
})

describe('documents and meetings', () => {
  it('lists documents in scope with a display path and no guessed URL', async () => {
    expect(await listDocuments(acc1, 'c2')).toEqual([])
    const docs = await listDocuments(acc1, 'c1')
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ path: 'Client Files/Alpha/invoice.pdf', url: null })
  })
  it('lists meetings in scope', async () => {
    expect(await listMeetings(viewAsRavi, 'c1')).toEqual([])
    const m = await listMeetings(acc1, 'c1')
    expect(m[0]).toMatchObject({ id: 'mt1', hasTranscript: true, link: 'https://teams.example.com/m1' })
  })
})

describe('timeline and recent activity', () => {
  it('merges every kind for one client, newest first', async () => {
    const items = await getTimeline(acc1, 'c1')
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'message:m3',
      'message:m2',
      'message:m1',
      'ticket:t1',
      'document:d1',
      'meeting:mt1',
      'ticket:t3',
    ])
    expect(items.find((i) => i.id === 'm2')?.direction).toBe('outgoing')
    expect(await getTimeline(acc1, 'c2')).toEqual([])
  })
  it('limits the timeline', async () => {
    expect(await getTimeline(acc1, 'c1', { limit: 2 })).toHaveLength(2)
  })
  it('builds a today feed across the user clients only', async () => {
    const feed = await listRecentActivity(acc1, { sinceHours: 24 })
    expect(feed.every((i) => i.clientId === 'c1')).toBe(true)
    expect(feed.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'message:m3',
      'message:m2',
      'message:m1',
      'ticket:t1',
      'document:d1',
      'meeting:mt1',
      'ticket:t3',
    ])
    expect(feed.find((i) => i.id === 't3')?.title).toBe('Closed: Bank statement')
    expect(feed[0].clientName).toBe('Alpha Traders')
    expect(await listRecentActivity(accNoVa)).toEqual([])
    const all = await listRecentActivity(admin, { sinceHours: 24 })
    expect(all.some((i) => i.clientId === 'c2')).toBe(true)
  })
})

describe('team overview, vas and system health', () => {
  it('listVas is admin and engineer only', async () => {
    expect(await listVas(acc1)).toEqual([])
    expect(await listVas(viewAsRavi)).toEqual([])
    expect(await listVas(admin)).toEqual([
      { id: 'va1', name: 'Asha', email: 'asha@example.com', status: 'active', clientCount: 1 },
      { id: 'va2', name: 'Ravi', email: 'ravi@example.com', status: 'active', clientCount: 1 },
    ])
  })
  it('getTeamOverview aggregates per accountant', async () => {
    await expect(getTeamOverview(acc1)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(getTeamOverview(viewAsRavi)).rejects.toBeInstanceOf(ForbiddenError)
    const o = await getTeamOverview(admin)
    expect(o.unassignedClients).toBe(1)
    expect(o.escalations.map((t) => t.id)).toEqual(['t1'])
    expect(o.lowestHealth.map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(o.accountants.find((a) => a.vaId === 'va1')).toMatchObject({
      clientCount: 1,
      openTickets: 1,
      openEscalations: 1,
      slaBreachedOpen: 1,
      unansweredClients: 1,
      avgServiceScore: 80,
    })
  })
  it('getSystemHealth is engineer only', async () => {
    await expect(getSystemHealth(admin)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(getSystemHealth(viewAsRavi)).rejects.toBeInstanceOf(ForbiddenError)
    const h = await getSystemHealth(engineer)
    // c1 is the only council client; its 3 messages have no processed_at.
    expect(h.processing).toMatchObject({ pending: 0, councilBacklog: 3, failed: 1 })
    expect(h.processing.recentFailures[0]).toMatchObject({ messageId: 'm1', error: 'timeout' })
    expect(h.messagesLast24h).toBe(4)
    expect(h.councilClients).toEqual([{ id: 'c1', name: 'Alpha Traders' }])
    expect(h.teamNumbersCount).toBe(2)
    expect(h.hubspotLastSync).toBeNull()
    expect(h.lastCouncilVerdictAt).toBeNull()
    expect(h.lastMessageAt).toBe(fake.tables.client_messages[2].message_timestamp)
  })
  it('getTeamOverview and getSystemHealth carry the HubSpot sync time and the last council verdict', async () => {
    fake.tables.settings.push({ key: 'hubspot_last_sync', value: '2026-11-16T04:00:00.000Z', note: null })
    fake.tables.council_verdicts = [
      { id: 'v1', created_at: hoursAgo(30 * 24 + 5), agreed: true, final_decision: 'new', claude_model: 'a', claude_latency_ms: 100, gpt_model: 'b', gpt_latency_ms: 200 },
      { id: 'v2', created_at: hoursAgo(2), agreed: false, final_decision: 'no_action', claude_model: 'a', claude_latency_ms: 300, gpt_model: 'b', gpt_latency_ms: null },
    ]
    expect((await getTeamOverview(admin)).hubspotLastSync).toBe('2026-11-16T04:00:00.000Z')
    const h = await getSystemHealth(engineer)
    expect(h.hubspotLastSync).toBe('2026-11-16T04:00:00.000Z')
    expect(h.lastCouncilVerdictAt).toBe(fake.tables.council_verdicts[1].created_at)
  })
  it('getCouncilUsage is engineer only and summarises the window', async () => {
    fake.tables.council_verdicts = [
      { id: 'v1', created_at: hoursAgo(30 * 24 + 5), agreed: true, final_decision: 'new', claude_model: 'a', claude_latency_ms: 100, gpt_model: 'b', gpt_latency_ms: 200 },
      { id: 'v2', created_at: hoursAgo(2), agreed: false, final_decision: 'no_action', claude_model: 'a', claude_latency_ms: 300, gpt_model: 'b', gpt_latency_ms: null },
    ]
    await expect(getCouncilUsage(admin)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(getCouncilUsage(viewAsRaw)).rejects.toBeInstanceOf(ForbiddenError)
    const u = await getCouncilUsage(engineer, 30)
    expect(u).toMatchObject({ windowDays: 30, verdicts: 1, agreedPct: 0, totalVerdicts: 2 })
    expect(u.lastVerdictEverAt).toBe(fake.tables.council_verdicts[1].created_at)
    expect(u.byDecision).toEqual([{ decision: 'no_action', count: 1 }])
  })
})

describe('fetchAll', () => {
  it('reads every page until a short page', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ i }))
    const pages: [number, number][] = []
    const out = await fetchAll('t', async (from, to) => {
      pages.push([from, to])
      return { data: rows.slice(from, to + 1), error: null }
    })
    expect(out).toHaveLength(2500)
    expect(pages).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })
  it('throws on error', async () => {
    await expect(fetchAll('label', async () => ({ data: null, error: { message: 'boom' } }))).rejects.toThrow('label: boom')
  })
})
