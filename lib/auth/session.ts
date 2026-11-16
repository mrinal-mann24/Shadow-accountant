import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { DEV_LOGIN_COOKIE, VIEW_AS_COOKIE } from './cookies'
import {
  applyViewAs,
  devLoginEmail,
  findVaByEmail,
  isTrustedSessionUser,
  resolveAppUser,
  type AuthIdentity,
  type VaRecord,
} from './roles'
import type { AppUser, Role } from './types'

export { canSeeAllClients, assertNotViewingAs, ForbiddenError, ViewAsReadOnlyError } from './roles'

export type AuthState =
  | { status: 'anonymous' }
  /** Signed in, but no role and no matching vas row: "not set up yet, ask Admin". */
  | { status: 'no_access'; email: string }
  /** `user` is the effective (possibly view-as scoped) user; `signedInUser` is always the real one. */
  | { status: 'ok'; user: AppUser; signedInUser: AppUser }

/** All accountants (small table). Service role, because `authenticated` has no RLS policies yet. Per request. */
export const loadVas = cache(async (): Promise<VaRecord[]> => {
  const { data, error } = await createAdminSupabase().from('vas').select('va_id, va_name, email').order('va_name')
  if (error) throw new Error(`Could not load accountants: ${error.message}`)
  return data ?? []
})

async function getIdentity(): Promise<AuthIdentity | 'no_email' | { untrusted: string } | null> {
  const supabase = await createServerSupabase()
  // getUser() asks the auth server, so app_metadata.role changes apply on the next request.
  const { data } = await supabase.auth.getUser()
  const u = data.user
  if (u) {
    if (!u.email) return 'no_email'
    // Only Microsoft SSO with a confirmed email is trusted for the role and vas email rules.
    if (!isTrustedSessionUser(u)) return { untrusted: u.email }
    const meta = u.user_metadata ?? {}
    const name = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : null
    return { id: u.id, email: u.email, name, appRole: u.app_metadata?.role }
  }

  // ---- DEV LOGIN (local development only; never in production) --------------------------------
  // Active only when NODE_ENV !== 'production' AND DEV_LOGIN_EMAIL is set AND the dev_login cookie
  // was set from the login page. Role comes from DEV_LOGIN_ROLE, else the usual vas email rule.
  const devEmail = devLoginEmail(process.env)
  if (devEmail && (await cookies()).get(DEV_LOGIN_COOKIE)?.value === '1') {
    return { id: `dev-login:${devEmail}`, email: devEmail, name: null, appRole: process.env.DEV_LOGIN_ROLE }
  }
  // ---- end DEV LOGIN ---------------------------------------------------------------------------
  return null
}

/** Full auth state for this request (cached per request). */
export const getAuthState = cache(async (): Promise<AuthState> => {
  const identity = await getIdentity()
  if (!identity) return { status: 'anonymous' }
  if (identity === 'no_email') return { status: 'no_access', email: '' }
  if ('untrusted' in identity) return { status: 'no_access', email: identity.untrusted }

  const vas = await loadVas()
  const signedInUser = resolveAppUser(identity, findVaByEmail(vas, identity.email))
  if (!signedInUser) return { status: 'no_access', email: identity.email }

  let user = signedInUser
  if (signedInUser.role === 'engineer') {
    const viewAsId = (await cookies()).get(VIEW_AS_COOKIE)?.value
    if (viewAsId) user = applyViewAs(signedInUser, vas.find((v) => v.va_id === viewAsId) ?? null)
  }
  return { status: 'ok', user, signedInUser }
})

/** Effective user (view-as scoped for engineers), or null when signed out or not set up. */
export async function getCurrentUser(): Promise<AppUser | null> {
  const state = await getAuthState()
  return state.status === 'ok' ? state.user : null
}

/**
 * Effective user, or redirect: signed out to /login, not set up to /no-access, wrong role to /home.
 * While an engineer views as an accountant, the role checked is senior_accountant.
 */
export async function requireUser(roles?: Role[]): Promise<AppUser> {
  const state = await getAuthState()
  if (state.status === 'anonymous') redirect('/login')
  if (state.status === 'no_access') redirect('/no-access')
  if (roles && !roles.includes(state.user.role)) redirect('/home')
  return state.user
}
