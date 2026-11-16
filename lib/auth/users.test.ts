import { describe, expect, it, vi } from 'vitest'
import type { User } from '@supabase/supabase-js'
import type { AppUser } from './types'

const updateUserById = vi.fn(async () => ({ error: null }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => ({
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id, app_metadata: { provider: 'azure' } } }, error: null }),
        updateUserById,
      },
    },
  }),
}))
vi.mock('./session', () => ({ loadVas: async () => [] }))

const { setUserRole, toListItem } = await import('./users')
const { ForbiddenError, ViewAsReadOnlyError } = await import('./roles')

const admin: AppUser = { id: 'admin-1', email: 'a@x.com', name: 'A', role: 'admin', vaId: null }
const vas = [{ va_id: 'va-1', va_name: 'Priya Sharma', email: 'PRIYA@x.com' }]
const user = (over: Partial<User>): User =>
  ({ id: 'u', email: 'priya@x.com', app_metadata: {}, user_metadata: {}, created_at: '2026-11-01T00:00:00Z', aud: 'authenticated', ...over }) as User

describe('toListItem', () => {
  it('shows the effective role: vas match without a role is senior_accountant', () => {
    expect(toListItem(user({}), vas)).toMatchObject({ role: null, effectiveRole: 'senior_accountant', vaId: 'va-1', vaName: 'Priya Sharma' })
  })
  it('explicit role wins; unknown email without a role has no access', () => {
    expect(toListItem(user({ app_metadata: { role: 'engineer' } }), vas)).toMatchObject({ role: 'engineer', effectiveRole: 'engineer' })
    expect(toListItem(user({ email: 'new@x.com' }), vas)).toMatchObject({ role: null, effectiveRole: null, vaId: null })
  })
})

describe('setUserRole', () => {
  it('merges the role into app_metadata', async () => {
    await setUserRole(admin, 'u-2', 'engineer')
    expect(updateUserById).toHaveBeenCalledWith('u-2', { app_metadata: { provider: 'azure', role: 'engineer' } })
  })
  it('is admin only, not while viewing as, and not on yourself', async () => {
    const engineer: AppUser = { ...admin, role: 'engineer' }
    await expect(setUserRole(engineer, 'u-2', 'admin')).rejects.toThrow(ForbiddenError)
    await expect(setUserRole({ ...admin, viewingAs: { vaId: 'va-1', name: 'P' } }, 'u-2', 'admin')).rejects.toThrow(ViewAsReadOnlyError)
    await expect(setUserRole(admin, 'admin-1', 'engineer')).rejects.toThrow('own role')
    await expect(setUserRole(admin, 'u-2', 'owner' as never)).rejects.toThrow('Unknown role')
  })
})
