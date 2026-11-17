// Pure role and scope rules. No I/O, safe for client and server, fully unit tested.
import { isRole, type AppUser } from './types'

export class ForbiddenError extends Error {
  constructor(message = 'You do not have access to do this.') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

/** Thrown by mutations while an engineer is using "view as" (view as is read-only). */
export class ViewAsReadOnlyError extends ForbiddenError {
  constructor() {
    super('You are viewing as another accountant. Changes are not allowed in this mode.')
    this.name = 'ViewAsReadOnlyError'
  }
}

/** Identity from the auth provider (Supabase user or dev login). */
export type AuthIdentity = {
  id: string
  email: string
  /** Display name from the provider, if any. */
  name: string | null
  /** Raw `app_metadata.role`; anything other than a valid Role counts as "no role". */
  appRole: unknown
}

export type VaRecord = { va_id: string; va_name: string; email: string | null }

/** The only sign-in provider the app accepts (Microsoft SSO, single-tenant app in Supabase Auth). */
export const TRUSTED_PROVIDER = 'azure'

/** The parts of a Supabase auth user that decide whether its email can be trusted. */
export type SessionUserLike = {
  email_confirmed_at?: string | null
  app_metadata?: { provider?: unknown; providers?: unknown } | null
  identities?: { provider?: unknown }[] | null
}

/**
 * True only when every identity on the account is Microsoft (azure) and the email is confirmed.
 * Supabase VA is a shared project: if email / password, magic link or another provider is ever enabled
 * there, a session for an accountant's email from that provider must not inherit their clients. An
 * account with any non-azure identity linked is rejected too, because its session may come from it.
 */
export function isTrustedSessionUser(u: SessionUserLike): boolean {
  if (!u.email_confirmed_at) return false
  const providers = new Set<unknown>()
  const meta = u.app_metadata ?? {}
  if (meta.provider !== undefined) providers.add(meta.provider)
  if (Array.isArray(meta.providers)) for (const p of meta.providers) providers.add(p)
  for (const i of u.identities ?? []) providers.add(i.provider)
  if (providers.size === 0) return false
  return [...providers].every((p) => p === TRUSTED_PROVIDER)
}

export function normaliseEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/** vas row whose email equals the login email (case-insensitive, trimmed), or null. */
export function findVaByEmail(vas: readonly VaRecord[], email: string): VaRecord | null {
  const target = normaliseEmail(email)
  if (!target) return null
  return vas.find((v) => normaliseEmail(v.email) === target) ?? null
}

/**
 * Role resolution:
 * - a valid `app_metadata.role` wins;
 * - no role but the email matches a `vas` row: senior_accountant (the default role);
 * - no role and no `vas` match: null, meaning "not set up yet, no access".
 */
export function resolveAppUser(identity: AuthIdentity, va: VaRecord | null): AppUser | null {
  const role = isRole(identity.appRole) ? identity.appRole : va ? 'senior_accountant' : null
  if (!role) return null
  const name = identity.name?.trim() || va?.va_name || identity.email
  return { id: identity.id, email: identity.email, name, role, vaId: va?.va_id ?? null }
}

/**
 * Engineer "view as": returns the accountant-scoped user (role senior_accountant, vaId of the target,
 * viewingAs filled). Ignored for anyone who is not an engineer, or when the target is unknown.
 */
export function applyViewAs(user: AppUser, target: VaRecord | null): AppUser {
  if (user.role !== 'engineer' || !target) return user
  return {
    ...user,
    role: 'senior_accountant',
    vaId: target.va_id,
    viewingAs: { vaId: target.va_id, name: target.va_name },
  }
}

/** Admin and engineer see every client. Senior accountants (and engineers viewing as one) see only their own. */
export function canSeeAllClients(u: AppUser): boolean {
  return !u.viewingAs && (u.role === 'admin' || u.role === 'engineer')
}

/** Call at the start of every mutation. Throws ViewAsReadOnlyError while viewing as someone. */
export function assertNotViewingAs(u: AppUser): void {
  if (u.viewingAs) throw new ViewAsReadOnlyError()
}

/** Only allow same-site relative paths after login, never `//host` or absolute URLs. */
export function safeNextPath(next: string | null | undefined, fallback = '/home'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  return next
}

/** Paths reachable without a session (middleware). Job and webhook routes do their own auth. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/api/jobs/') ||
    pathname.startsWith('/api/webhooks/')
  )
}

/**
 * DEV LOGIN (local development only). Enabled only when NODE_ENV is not 'production' AND
 * DEV_LOGIN_EMAIL is set. Never enabled in production, whatever else is set.
 */
export function devLoginEmail(env: { NODE_ENV?: string; DEV_LOGIN_EMAIL?: string; VERCEL_ENV?: string }): string | null {
  // Never on a server build, and never on a Vercel production or preview deployment.
  const vercel = env.VERCEL_ENV?.trim()
  if (env.NODE_ENV === 'production' || vercel === 'production' || vercel === 'preview') return null
  const email = env.DEV_LOGIN_EMAIL?.trim()
  return email ? email : null
}

/**
 * DEV LOGIN choice kept in the dev_login cookie (local development only):
 *  "1"          legacy: DEV_LOGIN_EMAIL with DEV_LOGIN_ROLE
 *  "engineer" / "admin"  that role, as DEV_LOGIN_EMAIL
 *  "va:<va_id>" that accountant, with their real vas email, so the senior accountant scope is exact
 */
export type DevLoginChoice =
  | { kind: 'legacy' }
  | { kind: 'role'; role: 'admin' | 'engineer' }
  | { kind: 'accountant'; vaId: string }

export function parseDevLoginChoice(value: string | null | undefined): DevLoginChoice | null {
  const v = value?.trim()
  if (!v) return null
  if (v === '1') return { kind: 'legacy' }
  if (v === 'admin' || v === 'engineer') return { kind: 'role', role: v }
  const m = /^va:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(v)
  return m ? { kind: 'accountant', vaId: m[1].toLowerCase() } : null
}

/** The DEV LOGIN identity for a choice; null when the accountant is unknown or has no email. */
export function devLoginIdentity(
  choice: DevLoginChoice,
  devEmail: string,
  vas: readonly VaRecord[],
  envRole?: string,
): AuthIdentity | null {
  if (choice.kind === 'legacy') return { id: `dev-login:${devEmail}`, email: devEmail, name: null, appRole: envRole }
  if (choice.kind === 'role') {
    const name = choice.role === 'admin' ? 'Dev Admin' : 'Dev Engineer'
    return { id: `dev-login:${choice.role}`, email: devEmail, name, appRole: choice.role }
  }
  const va = vas.find((v) => v.va_id.toLowerCase() === choice.vaId)
  if (!va?.email) return null
  return { id: `dev-login:${va.va_id}`, email: va.email, name: va.va_name, appRole: 'senior_accountant' }
}
