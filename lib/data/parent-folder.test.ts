import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUser } from '@/lib/auth/types'
import { createFakeSupabase } from './testing/fake-supabase'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import { parentFolderName } from './index'

const asha: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }

beforeEach(() => {
  state.db = createFakeSupabase({
    vas: [
      { va_id: 'va1', va_name: 'Asha', email: 'asha@example.com', status: 'active' },
      { va_id: 'va2', va_name: 'Ravi', email: 'ravi@example.com', status: 'active' },
    ],
    clients: [
      // Parent group belongs to another accountant; Asha has only the sub-group.
      { client_id: 'p1', client_name: 'Nyvu', whatsapp_group_name: 'Nyvu Main Group', va_id: 'va2', parent_client_id: null },
      { client_id: 'c1', client_name: 'Nyvu Assets', whatsapp_group_name: 'Nyvu Assets payments', va_id: 'va1', parent_client_id: 'p1' },
      { client_id: 'c2', client_name: 'Solo Co', whatsapp_group_name: null, va_id: 'va1', parent_client_id: null },
      { client_id: 'c3', client_name: 'Other Sub', whatsapp_group_name: null, va_id: 'va2', parent_client_id: 'p1' },
      { client_id: 'p2', client_name: 'No Group Parent', whatsapp_group_name: null, va_id: 'va2', parent_client_id: null },
      { client_id: 'c4', client_name: 'Child of p2', whatsapp_group_name: null, va_id: 'va1', parent_client_id: 'p2' },
    ],
  }).client
})

describe('parentFolderName', () => {
  it("returns the parent's group name even when the parent is another accountant's client", async () => {
    expect(await parentFolderName(asha, 'c1')).toBe('Nyvu Main Group')
  })
  it('falls back to the parent client name, and is null without a parent', async () => {
    expect(await parentFolderName(asha, 'c4')).toBe('No Group Parent')
    expect(await parentFolderName(asha, 'c2')).toBeNull()
  })
  it('is null for a client the user may not see', async () => {
    expect(await parentFolderName(asha, 'c3')).toBeNull()
  })
})
