import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyViewAs, ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'
import { guideSettingKey, PILOT_SETTING_KEY, serializeGuide } from '@/lib/reply/style-guide'
import { createFakeSupabase, type FakeOptions, type FakeTables } from './testing/fake-supabase'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import {
  findRecentSuggestion,
  getReplyStyle,
  isMissingTable,
  listReplyCorrections,
  recordReplySuggestion,
  saveReplySuggestion,
} from './reply-suggestions'

const asha: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const admin: AppUser = { id: 'u2', email: 'admin@example.com', name: 'Admin', role: 'admin', vaId: null }
const guide = { guide: '## 1. a\n## 7. b', version: 1, model: 'm', builtAt: '2026-11-27T00:00:00Z', messages: 5, corrections: 0 }
const ASHA_VA = { va_id: 'va1', va_name: 'Asha', email: 'asha@example.com' }

function fixtures(): FakeTables {
  return {
    vas: [{ va_id: 'va1', va_name: 'Asha', email: 'asha@example.com', status: 'active' }],
    clients: [
      { client_id: 'c1', client_name: 'KRRD', va_id: 'va1' },
      { client_id: 'c2', client_name: 'Other', va_id: 'va2' },
      { client_id: 'c3', client_name: 'Not pilot', va_id: 'va1' },
    ],
    settings: [
      { key: PILOT_SETTING_KEY, value: JSON.stringify(['c1', 'c2']) },
      { key: guideSettingKey('c1'), value: serializeGuide(guide) },
      { key: guideSettingKey('c2'), value: serializeGuide(guide) },
      { key: guideSettingKey('c3'), value: serializeGuide(guide) },
    ],
    reply_suggestions: [
      {
        id: 's1',
        client_id: 'c1',
        conversation_id: 't1',
        draft: 'Will check',
        final_text: 'Checked sir',
        action: 'edited',
        created_at: '2026-11-27T05:00:00Z',
        acted_at: '2026-11-27T05:05:00Z',
      },
      {
        id: 's2',
        client_id: 'c1',
        conversation_id: 't1',
        draft: 'Discarded one',
        final_text: null,
        action: 'discarded',
        created_at: '2026-11-27T06:00:00Z',
        acted_at: '2026-11-27T06:01:00Z',
      },
      {
        id: 's3',
        client_id: 'c2',
        conversation_id: 't9',
        draft: 'x',
        final_text: 'y',
        action: 'edited',
        created_at: '2026-11-27T05:00:00Z',
        acted_at: '2026-11-27T05:05:00Z',
      },
    ],
  }
}

let fake: ReturnType<typeof createFakeSupabase>
function setup(opts: FakeOptions = {}) {
  fake = createFakeSupabase(fixtures(), opts)
  state.db = fake.client
}
beforeEach(() => setup())

describe('getReplyStyle', () => {
  it('returns the guide for a pilot client in scope only', async () => {
    expect(await getReplyStyle(asha, 'c1')).toMatchObject({ version: 1 })
    expect(await getReplyStyle(asha, 'c2')).toBeNull() // not her client
    expect(await getReplyStyle(asha, 'c3')).toBeNull() // has a guide but is not in the pilot list
    expect(await getReplyStyle(admin, 'c2')).toMatchObject({ version: 1 })
  })
})

describe('corrections and recent suggestions', () => {
  it('lists edited suggestions for the client, scoped', async () => {
    expect(await listReplyCorrections(asha, 'c1', 5)).toEqual([{ draft: 'Will check', finalText: 'Checked sir' }])
    expect(await listReplyCorrections(asha, 'c2', 5)).toEqual([])
  })
  it('finds the latest suggestion since the client message, skipping discarded ones', async () => {
    expect(await findRecentSuggestion(asha, { conversationId: 't1', clientId: 'c1', since: '2026-11-27T04:00:00Z' })).toMatchObject({
      id: 's1',
      finalText: 'Checked sir',
      action: 'edited',
    })
    expect(await findRecentSuggestion(asha, { conversationId: 't1', clientId: 'c1', since: '2026-11-27T07:00:00Z' })).toBeNull()
    expect(await findRecentSuggestion(asha, { conversationId: 't9', clientId: 'c2', since: '2026-11-27T00:00:00Z' })).toBeNull()
  })
})

describe('saveReplySuggestion', () => {
  const row = {
    conversationId: 't1',
    clientId: 'c1',
    model: 'm',
    guideVersion: 1,
    promptVersion: 'v3',
    draft: 'OTP is 445566, call 9876543210',
  }
  it('stores a masked draft with who saw it', async () => {
    await saveReplySuggestion(asha, row)
    const saved = fake.tables.reply_suggestions.at(-1)!
    expect(saved).toMatchObject({ client_id: 'c1', conversation_id: 't1', user_email: 'asha@example.com', prompt_version: 'v3' })
    expect(saved.draft).toBe('OTP is [hidden], call [number]')
  })
  it('saves nothing while viewing as someone, and refuses another accountant’s client', async () => {
    const viewing = applyViewAs({ ...admin, role: 'engineer' }, ASHA_VA)
    expect(await saveReplySuggestion(viewing, row)).toBeNull()
    await expect(saveReplySuggestion(asha, { ...row, clientId: 'c2' })).rejects.toBeInstanceOf(ForbiddenError)
  })
  it('saves nothing before the table exists', async () => {
    setup({ fail: ({ table }) => (table === 'reply_suggestions' ? { message: 'relation does not exist', code: '42P01' } : null) })
    expect(await saveReplySuggestion(asha, row)).toBeNull()
  })
})

describe('recordReplySuggestion', () => {
  it('records an edit with the masked final text', async () => {
    fake.tables.reply_suggestions.push({ id: 's9', client_id: 'c1', conversation_id: 't1', draft: 'Will check', final_text: null, action: null })
    await recordReplySuggestion(asha, 's9', 'edited', 'Done sir, account 123456789012')
    expect(fake.tables.reply_suggestions.find((r) => r.id === 's9')).toMatchObject({
      action: 'edited',
      final_text: 'Done sir, account [number]',
    })
  })
  it('an "edit" that changed nothing is recorded as copied', async () => {
    fake.tables.reply_suggestions.push({ id: 's8', client_id: 'c1', conversation_id: 't1', draft: 'Noted sir', final_text: null, action: null })
    await recordReplySuggestion(asha, 's8', 'edited', 'Noted sir')
    expect(fake.tables.reply_suggestions.find((r) => r.id === 's8')).toMatchObject({ action: 'copied' })
  })
  it('refuses viewing as, other clients and unknown ids', async () => {
    const viewing = applyViewAs({ ...admin, role: 'engineer' }, ASHA_VA)
    await expect(recordReplySuggestion(viewing, 's1', 'copied', 'x')).rejects.toBeInstanceOf(ViewAsReadOnlyError)
    await expect(recordReplySuggestion(asha, 's3', 'copied', 'y')).rejects.toBeInstanceOf(ForbiddenError)
    await expect(recordReplySuggestion(asha, 'nope', 'copied', 'y')).rejects.toThrow('Suggestion not found.')
  })
})

describe('isMissingTable', () => {
  it('knows the Postgres and PostgREST codes', () => {
    expect(isMissingTable({ code: '42P01' })).toBe(true)
    expect(isMissingTable({ code: 'PGRST205' })).toBe(true)
    expect(isMissingTable({ message: 'Could not find the table public.reply_suggestions' })).toBe(true)
    expect(isMissingTable({ code: '23505', message: 'duplicate' })).toBe(false)
    expect(isMissingTable(null)).toBe(false)
  })
})
