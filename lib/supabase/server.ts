import 'server-only'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { publicEnv } from '@/lib/env'
import type { Database } from '@/lib/db/types'

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * Uses the anon key plus the logged-in user's session from cookies, so RLS applies.
 * Until RLS policies exist, use it for auth (getUser) only; data goes through lib/data/* (admin client).
 */
export async function createServerSupabase(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies()
  const env = publicEnv()
  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options)
        } catch {
          // Called from a Server Component, where cookies are read-only. middleware.ts refreshes the session.
        }
      },
    },
  })
}
