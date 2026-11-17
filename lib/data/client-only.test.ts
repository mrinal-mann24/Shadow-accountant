import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUser } from '@/lib/auth/types'
import { TAGS } from '@/lib/council/types'
import { TAG_LABELS } from '@/components/accountant/ticket-intent'
import { clearTeamNumbersCache } from '@/lib/team'
import { createFakeSupabase } from './testing/fake-supabase'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import { isClientFile, listDocuments } from './documents'
import { getTimeline } from './timeline'

const admin: AppUser = { id: 'u', email: 'a@x.com', name: 'A', role: 'admin', vaId: null }
const doc = (id: string, sender: string | null) => ({
  upload_id: id, client_id: 'c1', file_name: `${id}.pdf`, folder_name: 'Alpha', file_type: 'pdf', file_size: 1,
  uploaded_at: '2026-11-17T05:00:00Z', group_name: null, sender_phone: sender,
})
const msg = (id: string, direction: string) => ({
  message_id: id, dedup_hash: id, client_id: 'c1', message_timestamp: '2026-11-17T05:00:00Z', body: `text ${id}`,
  sender_name: null, sender_phone: null, direction, message_type: 'chat', conversation_id: null,
})

beforeEach(() => {
  state.db = createFakeSupabase({
    vas: [],
    settings: [{ key: 'team_whatsapp_numbers', value: '9741428606', note: null }],
    clients: [{ client_id: 'c1', client_name: 'Alpha', va_id: null }],
    document_uploads: [doc('client', '918888888888'), doc('team', '919741428606'), doc('unknown', null)],
    client_messages: [msg('in', 'incoming'), msg('out', 'outgoing')],
    va_meeting_transcripts: [],
    conversations: [],
  }).client
  clearTeamNumbersCache()
})

describe('client page shows only what the client sent', () => {
  it('isClientFile: team number is not the client; unknown sender is', () => {
    const team = new Set(['9741428606'])
    expect(isClientFile({ sender_phone: '+91 97414 28606' }, team)).toBe(false)
    expect(isClientFile({ sender_phone: '918888888888' }, team)).toBe(true)
    expect(isClientFile({ sender_phone: null }, team)).toBe(true)
  })
  it('listDocuments clientOnly drops files our team sent; default keeps all', async () => {
    expect((await listDocuments(admin, 'c1', { clientOnly: true })).map((d) => d.id).sort()).toEqual(['client', 'unknown'])
    expect(await listDocuments(admin, 'c1')).toHaveLength(3)
  })
  it('getTimeline clientOnly drops outgoing messages and team files', async () => {
    const t = await getTimeline(admin, 'c1', { clientOnly: true })
    expect(t.filter((i) => i.kind === 'message').map((i) => i.id)).toEqual(['in'])
    expect(t.filter((i) => i.kind === 'document').map((i) => i.id).sort()).toEqual(['client', 'unknown'])
    const all = await getTimeline(admin, 'c1')
    expect(all.filter((i) => i.kind === 'message')).toHaveLength(2)
  })
})

describe('Suspense tag', () => {
  it('is a valid ticket tag with a label', () => {
    expect(TAGS).toContain('suspense')
    expect(TAG_LABELS.suspense).toBe('Suspense')
  })
})
