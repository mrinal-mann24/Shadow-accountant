import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyViewAs, ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'
import { createFakeSupabase, type FakeTables } from './testing/fake-supabase'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => state.db }))

import { reassignTicket, ticketForUser } from './index'

const asha: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }
const admin: AppUser = { id: 'u2', email: 'admin@example.com', name: 'Admin', role: 'admin', vaId: null }
const engineer: AppUser = { id: 'u3', email: 'eng@example.com', name: 'Eng', role: 'engineer', vaId: null }

function fixtures(): FakeTables {
  return {
    vas: [
      { va_id: 'va1', va_name: 'Asha', email: 'asha@example.com', status: 'active' },
      { va_id: 'va2', va_name: 'Ravi', email: 'ravi@example.com', status: 'active' },
    ],
    clients: [
      { client_id: 'c1', client_name: 'Alpha', va_id: 'va1' },
      { client_id: 'c2', client_name: 'Beta', va_id: 'va2' },
    ],
    conversations: [
      { id: 't1', client_id: 'c1', va_id: null, status: 'open', updated_at: '2026-11-01T00:00:00Z' },
      { id: 't2', client_id: 'c2', va_id: 'va2', status: 'closed', updated_at: '2026-11-01T00:00:00Z' },
    ],
  }
}

let fake: ReturnType<typeof createFakeSupabase>
beforeEach(() => {
  fake = createFakeSupabase(fixtures())
  state.db = fake.client
})

describe('ticketForUser', () => {
  it('returns the ticket for a senior accountant on their own client', async () => {
    expect(await ticketForUser(asha, 't1')).toEqual({ id: 't1', clientId: 'c1', vaId: null, status: 'open' })
  })

  it('returns null for a ticket on another accountant client', async () => {
    expect(await ticketForUser(asha, 't2')).toBeNull()
  })

  it('admins and engineers see every ticket', async () => {
    expect(await ticketForUser(admin, 't2')).toEqual({ id: 't2', clientId: 'c2', vaId: 'va2', status: 'closed' })
    expect((await ticketForUser(engineer, 't1'))?.id).toBe('t1')
  })

  it('view as is scoped to the target accountant', async () => {
    const viewing = applyViewAs(engineer, { va_id: 'va1', va_name: 'Asha', email: 'asha@example.com' })
    expect((await ticketForUser(viewing, 't1'))?.id).toBe('t1')
    expect(await ticketForUser(viewing, 't2')).toBeNull()
  })

  it('returns null when the ticket does not exist or the id is empty', async () => {
    expect(await ticketForUser(admin, 'nope')).toBeNull()
    expect(await ticketForUser(admin, '')).toBeNull()
  })

  it('senior accountant without vaId sees nothing', async () => {
    expect(await ticketForUser({ ...asha, vaId: null }, 't1')).toBeNull()
  })
})

describe('reassignTicket', () => {
  it('admin sets conversations.va_id and updated_at', async () => {
    await reassignTicket(admin, 't1', 'va2')
    const row = fake.tables.conversations.find((r) => r.id === 't1')
    expect(row?.va_id).toBe('va2')
    expect(row?.updated_at).not.toBe('2026-11-01T00:00:00Z')
  })

  it('is admin only', async () => {
    await expect(reassignTicket(asha, 't1', 'va2')).rejects.toBeInstanceOf(ForbiddenError)
    await expect(reassignTicket(engineer, 't1', 'va2')).rejects.toBeInstanceOf(ForbiddenError)
    expect(fake.calls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  it('refuses while viewing as', async () => {
    const viewing = { ...admin, viewingAs: { vaId: 'va1', name: 'Asha' } }
    await expect(reassignTicket(viewing, 't1', 'va2')).rejects.toBeInstanceOf(ViewAsReadOnlyError)
  })

  it('throws when the accountant does not exist', async () => {
    await expect(reassignTicket(admin, 't1', 'va9')).rejects.toThrow('Accountant not found.')
    expect(fake.tables.conversations.find((r) => r.id === 't1')?.va_id).toBeNull()
  })

  it('throws when the ticket does not exist', async () => {
    await expect(reassignTicket(admin, 'nope', 'va2')).rejects.toThrow('Ticket not found.')
  })
})
