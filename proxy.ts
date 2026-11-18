// Session refresh (@supabase/ssr pattern) and the sign-in gate. Role checks happen in pages via requireUser().
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { publicEnv } from '@/lib/env'
import { DEV_LOGIN_COOKIE } from '@/lib/auth/cookies'
import { devLoginEmail, isPublicPath, parseDevLoginChoice } from '@/lib/auth/roles'

export async function proxy(request: NextRequest) {
  // Job, webhook and Teams bot routes authenticate themselves (cron secret, HubSpot signature, Bot Framework
  // JWT); no session needed.
  const p = request.nextUrl.pathname
  if (p.startsWith('/api/jobs/') || p.startsWith('/api/webhooks/') || p.startsWith('/api/teams/')) return NextResponse.next()

  let response = NextResponse.next({ request })
  const env = publicEnv()

  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options)
      },
    },
  })

  // Do not run code between createServerClient and getUser(): it refreshes the session cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname, search } = request.nextUrl
  if (user || isPublicPath(pathname)) return response

  // DEV LOGIN (local development only; devLoginEmail() returns null in production).
  if (devLoginEmail(process.env) && parseDevLoginChoice(request.cookies.get(DEV_LOGIN_COOKIE)?.value)) return response

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  }
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`
  const redirect = NextResponse.redirect(url)
  // Keep any refreshed or cleared auth cookies on the redirect.
  for (const c of response.cookies.getAll()) redirect.cookies.set(c)
  return redirect
}

export const config = {
  // Everything except Next internals and static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)'],
}
