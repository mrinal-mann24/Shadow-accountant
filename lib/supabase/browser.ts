import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { publicEnv } from '@/lib/env'
import type { Database } from '@/lib/db/types'

let client: SupabaseClient<Database> | null = null

/** Browser Supabase client. Auth only (sign in, sign out, session); never read data from the browser. */
export function createBrowserSupabase(): SupabaseClient<Database> {
  if (client) return client
  const env = publicEnv()
  client = createBrowserClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  return client
}
