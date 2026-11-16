// OAuth (Microsoft via Supabase Auth, PKCE) callback: exchange the code for a session cookie.
import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/auth/roles'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = safeNextPath(url.searchParams.get('next'))

  if (!code) {
    const reason = url.searchParams.get('error_description') ? 'provider' : 'missing_code'
    return NextResponse.redirect(new URL(`/login?error=${reason}`, url.origin))
  }

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) return NextResponse.redirect(new URL('/login?error=exchange', url.origin))

  return NextResponse.redirect(new URL(next, url.origin))
}
