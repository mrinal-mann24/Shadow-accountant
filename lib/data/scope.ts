import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser, Role } from '@/lib/auth/types'
import { assertNotViewingAs, canSeeAllClients, ForbiddenError } from '@/lib/auth/roles'
import type { Database } from '@/lib/db/types'
import { fetchAll } from './paginate'

export type Db = SupabaseClient<Database>

/** all: every client. Otherwise only clients with clients.va_id = vaId (none when vaId is null). */
export type Scope = { all: true } | { all: false; vaId: string | null }

export function scopeOf(user: AppUser): Scope {
  if (user.viewingAs) return { all: false, vaId: user.viewingAs.vaId }
  if (canSeeAllClients(user)) return { all: true }
  return { all: false, vaId: user.vaId }
}

/** Throws ForbiddenError unless the user (not viewing as someone) has one of the roles. */
export function requireRole(user: AppUser, roles: Role[]): void {
  if (user.viewingAs || !roles.includes(user.role)) throw new ForbiddenError()
}

/** For every mutation: view as is read-only, and the role must be allowed. */
export function assertCanMutate(user: AppUser, roles: Role[]): void {
  assertNotViewingAs(user)
  requireRole(user, roles)
}

/** Client ids the user may see, or null for "all clients". */
export async function scopedClientIds(db: Db, user: AppUser): Promise<string[] | null> {
  const scope = scopeOf(user)
  if (scope.all) return null
  if (!scope.vaId) return []
  const vaId = scope.vaId
  const rows = await fetchAll('scopedClientIds', (from, to) =>
    db.from('clients').select('client_id').eq('va_id', vaId).order('client_id').range(from, to),
  )
  return rows.map((r) => r.client_id)
}

/** Postgres "invalid input syntax" (for example a malformed uuid in the URL): treat as not found. */
export function isInvalidInput(error: { code?: string } | null): boolean {
  return error?.code === '22P02'
}

/** True when the client exists and is inside the user's scope. */
export async function canAccessClient(db: Db, user: AppUser, clientId: string): Promise<boolean> {
  if (!clientId) return false
  const scope = scopeOf(user)
  if (!scope.all && !scope.vaId) return false
  const { data, error } = await db.from('clients').select('client_id, va_id').eq('client_id', clientId).maybeSingle()
  if (error) {
    if (isInvalidInput(error)) return false
    throw new Error(`canAccessClient: ${error.message}`)
  }
  if (!data) return false
  return scope.all || data.va_id === scope.vaId
}
