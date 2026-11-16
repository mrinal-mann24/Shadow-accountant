import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { Database } from '@/lib/db/types'
import { parseTeamNumbers } from './phone'

export { normalizePhone, parseTeamNumbers, effectiveDirection, type Direction } from './phone'

export const TEAM_NUMBERS_SETTING_KEY = 'team_whatsapp_numbers'

// Short-lived memo: one lookup serves every call in a request (and in a batch job), and a change to the
// settings row is picked up within a minute. React cache() is not used because it does not memoise
// inside route handlers, which is where the jobs run.
const TTL_MS = 60_000
let memo: { at: number; value: Promise<Set<string>> } | null = null

export async function loadTeamNumbers(db: SupabaseClient<Database>): Promise<Set<string>> {
  const [vas, setting] = await Promise.all([
    db.from('vas').select('whatsapp_number'),
    db.from('settings').select('value').eq('key', TEAM_NUMBERS_SETTING_KEY).maybeSingle(),
  ])
  if (vas.error) throw new Error(`getTeamNumbers: vas: ${vas.error.message}`)
  if (setting.error) throw new Error(`getTeamNumbers: settings: ${setting.error.message}`)
  return parseTeamNumbers(
    (vas.data ?? []).map((v) => v.whatsapp_number),
    setting.data?.value ?? null,
  )
}

/** vas.whatsapp_number + settings 'team_whatsapp_numbers', normalised (last 10 digits). Cached for 60 s. */
export async function getTeamNumbers(): Promise<Set<string>> {
  const now = Date.now()
  if (memo && now - memo.at < TTL_MS) return memo.value
  const value = loadTeamNumbers(createAdminSupabase())
  memo = { at: now, value }
  value.catch(() => {
    if (memo?.value === value) memo = null
  })
  return value
}

/** Test helper: forget the cached team numbers. */
export function clearTeamNumbersCache(): void {
  memo = null
}
