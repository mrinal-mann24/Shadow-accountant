// Sign out: POST only (a form button), so a link or prefetch cannot sign anyone out.
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerSupabase } from '@/lib/supabase/server'
import { DEV_LOGIN_COOKIE, VIEW_AS_COOKIE } from '@/lib/auth/cookies'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const supabase = await createServerSupabase()
  await supabase.auth.signOut()
  const jar = await cookies()
  jar.delete(VIEW_AS_COOKIE)
  jar.delete(DEV_LOGIN_COOKIE)
  // 303 so the browser follows with GET.
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 })
}
