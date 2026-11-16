import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { serverEnv } from '@/lib/env'
import type { Database } from '@/lib/db/types'

let client: SupabaseClient<Database> | null = null

/**
 * Service-role client. Bypasses RLS: server code only (lib/data/*, jobs).
 * Every caller must scope rows by AppUser itself. Never pass this client or its key to the browser.
 */
export function createAdminSupabase(): SupabaseClient<Database> {
  if (client) return client
  const env = serverEnv()
  client = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return client
}
