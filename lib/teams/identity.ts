import 'server-only'
import type { User } from '@supabase/supabase-js'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { findVaByEmail, isTrustedSessionUser, normaliseEmail, resolveAppUser, type VaRecord } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'

// Maps the email of a Teams member (from the Bot Framework roster, so already verified by Microsoft) to the same
// AppUser the web app would build: role from app_metadata.role of a trusted (Microsoft SSO) auth user, otherwise
// senior_accountant when the email matches a vas row, otherwise no access (null). Service role, server only.

export const USERS_PER_PAGE = 200
export const MAX_USER_PAGES = 10
/** How long a resolved user (or a "no access" null) is reused, and how many emails are kept. */
export const USER_CACHE_TTL_MS = 60_000
export const USER_CACHE_MAX = 500

export type IdentityDeps = {
  loadVas: () => Promise<VaRecord[]>
  /** One page (1-based) of Supabase auth users. */
  listUsers: (page: number, perPage: number) => Promise<User[]>
}

export const defaultIdentityDeps: IdentityDeps = {
  loadVas: async () => {
    const { data, error } = await createAdminSupabase().from('vas').select('va_id, va_name, email').order('va_name')
    if (error) throw new Error(`appUserByEmail: vas: ${error.message}`)
    return data ?? []
  },
  listUsers: async (page, perPage) => {
    const { data, error } = await createAdminSupabase().auth.admin.listUsers({ page, perPage })
    if (error) throw new Error(`appUserByEmail: users: ${error.message}`)
    return data.users
  },
}

async function findAuthUser(deps: IdentityDeps, email: string): Promise<User | null> {
  for (let page = 1; page <= MAX_USER_PAGES; page++) {
    const users = await deps.listUsers(page, USERS_PER_PAGE)
    const found = users.find((u) => normaliseEmail(u.email) === email)
    if (found) return found
    if (users.length < USERS_PER_PAGE) break
  }
  return null
}

function displayName(u: User): string | null {
  const meta = u.user_metadata ?? {}
  if (typeof meta.full_name === 'string' && meta.full_name.trim()) return meta.full_name
  if (typeof meta.name === 'string' && meta.name.trim()) return meta.name
  return null
}

/** Guest (B2B) accounts carry '#EXT#' in their UPN. They never get access through Teams. */
export function isGuestEmail(email: string | null | undefined): boolean {
  return (email ?? '').toUpperCase().includes('#EXT#')
}

/** The AppUser for an email, or null when the email is unknown, a guest, or has no access. */
export async function appUserByEmailWith(deps: IdentityDeps, rawEmail: string): Promise<AppUser | null> {
  const email = normaliseEmail(rawEmail)
  if (!email || !email.includes('@') || isGuestEmail(email)) return null
  const [vas, authUser] = await Promise.all([deps.loadVas(), findAuthUser(deps, email)])
  const va = findVaByEmail(vas, email)
  // An auth user with any non-Microsoft identity (or an unconfirmed email) is ignored, as on web sign-in.
  const trusted = authUser && isTrustedSessionUser(authUser) ? authUser : null
  if (!trusted && !va) return null
  return resolveAppUser(
    {
      id: trusted ? trusted.id : `teams:${email}`,
      email: trusted?.email ? normaliseEmail(trusted.email) : email,
      name: trusted ? displayName(trusted) : null,
      appRole: trusted?.app_metadata?.role,
    },
    va,
  )
}

/**
 * Wraps a resolver with a small per-instance cache (results and nulls, keyed by normalised email). Errors are not
 * cached. Bounded: the oldest entry is dropped when full. Best effort per server instance (not shared).
 */
export function cachedResolver(
  resolve: (email: string) => Promise<AppUser | null>,
  o: { ttlMs?: number; max?: number; now?: () => number } = {},
): { resolve: (email: string) => Promise<AppUser | null>; reset: () => void } {
  const ttl = o.ttlMs ?? USER_CACHE_TTL_MS
  const max = o.max ?? USER_CACHE_MAX
  const now = o.now ?? Date.now
  const cache = new Map<string, { at: number; user: AppUser | null }>()
  return {
    resolve: async (rawEmail) => {
      const key = normaliseEmail(rawEmail)
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttl) return hit.user
      cache.delete(key)
      const user = await resolve(rawEmail)
      cache.set(key, { at: now(), user })
      while (cache.size > max) cache.delete(cache.keys().next().value as string)
      return user
    },
    reset: () => cache.clear(),
  }
}

const defaultResolver = cachedResolver((email) => appUserByEmailWith(defaultIdentityDeps, email))

/** ResolveUser (lib/teams/types.ts) with the real service-role clients, cached for 60 s per email. */
export function appUserByEmail(email: string): Promise<AppUser | null> {
  return defaultResolver.resolve(email)
}

/** Clears the appUserByEmail cache (tests). */
export function resetIdentityCache(): void {
  defaultResolver.reset()
}
