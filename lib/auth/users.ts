import 'server-only'
// Admin user management over the Supabase Auth admin API (service role). Admin only.
import type { User } from '@supabase/supabase-js'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { assertNotViewingAs, findVaByEmail, ForbiddenError, type VaRecord } from './roles'
import { loadVas } from './session'
import { isRole, type AppUser, type Role } from './types'

export type AppUserListItem = {
  id: string
  email: string
  name: string | null
  /** Explicit app_metadata.role, or null when none is set. */
  role: Role | null
  /** Role the app actually applies (null role + vas match = senior_accountant; else null = no access). */
  effectiveRole: Role | null
  vaId: string | null
  vaName: string | null
  createdAt: string
  lastSignInAt: string | null
}

function assertAdmin(admin: AppUser): void {
  assertNotViewingAs(admin)
  if (admin.role !== 'admin') throw new ForbiddenError('Only admins can manage users.')
}

/** Pure mapping, exported for tests. */
export function toListItem(u: User, vas: readonly VaRecord[]): AppUserListItem {
  const email = u.email ?? ''
  const va = email ? findVaByEmail(vas, email) : null
  const role = isRole(u.app_metadata?.role) ? (u.app_metadata.role as Role) : null
  const meta = u.user_metadata ?? {}
  const name = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : null
  return {
    id: u.id,
    email,
    name,
    role,
    effectiveRole: role ?? (va ? 'senior_accountant' : null),
    vaId: va?.va_id ?? null,
    vaName: va?.va_name ?? null,
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at ?? null,
  }
}

/** Every auth user (people who have signed in at least once), sorted by email. Admin only. */
export async function listAppUsers(admin: AppUser): Promise<AppUserListItem[]> {
  assertAdmin(admin)
  const supabase = createAdminSupabase()
  const users: User[] = []
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`Could not list users: ${error.message}`)
    users.push(...data.users)
    if (data.users.length < 200) break
  }
  const vas = await loadVas()
  return users.map((u) => toListItem(u, vas)).sort((a, b) => a.email.localeCompare(b.email))
}

/**
 * Set (or clear, with null) a user's app_metadata.role. Admin only; admins cannot change their own role,
 * so nobody locks themselves out. Takes effect on the user's next request.
 */
export async function setUserRole(admin: AppUser, userId: string, role: Role | null): Promise<void> {
  assertAdmin(admin)
  if (role !== null && !isRole(role)) throw new ForbiddenError('Unknown role.')
  if (userId === admin.id) throw new ForbiddenError('You cannot change your own role.')
  const supabase = createAdminSupabase()
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  if (error || !data.user) throw new Error(`Could not load user: ${error?.message ?? 'not found'}`)
  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...data.user.app_metadata, role },
  })
  if (updateError) throw new Error(`Could not update role: ${updateError.message}`)
}
