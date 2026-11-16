'use server'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/lib/supabase/server'
import { AUTH_COOKIE_OPTIONS, DEV_LOGIN_COOKIE, VIEW_AS_COOKIE } from '@/lib/auth/cookies'
import { devLoginEmail, parseDevLoginChoice, safeNextPath } from '@/lib/auth/roles'

async function siteOrigin(): Promise<string> {
  const h = await headers()
  const origin = h.get('origin')
  if (origin) return origin
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

/** Start Microsoft SSO (Supabase provider 'azure'). PKCE verifier is stored in a cookie by @supabase/ssr. */
export async function signInWithMicrosoft(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get('next')?.toString())
  const supabase = await createServerSupabase()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      scopes: 'openid email profile',
      redirectTo: `${await siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  })
  if (error || !data.url) redirect('/login?error=start')
  redirect(data.url)
}

/**
 * DEV LOGIN (local development only). Works only when NODE_ENV !== 'production' AND DEV_LOGIN_EMAIL is set.
 * Signs in without Microsoft as the role picked on the login page: Engineer, Admin, or one accountant
 * (form field "as": "engineer" | "admin" | "va:<va_id>"; anything else falls back to the legacy single user).
 * Never available in production.
 */
export async function devLogin(formData: FormData): Promise<void> {
  if (!devLoginEmail(process.env)) redirect('/login')
  const as = formData.get('as')?.toString() ?? ''
  const jar = await cookies()
  jar.set(DEV_LOGIN_COOKIE, parseDevLoginChoice(as) ? as : '1', AUTH_COOKIE_OPTIONS)
  jar.delete(VIEW_AS_COOKIE)
  redirect(safeNextPath(formData.get('next')?.toString()))
}
