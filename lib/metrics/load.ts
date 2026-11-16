import 'server-only'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/data/paginate'
import { effectiveDirection, getTeamNumbers } from '@/lib/team'
import type { MetricMessage } from './index'

/**
 * Messages for one client over the last `windowDays`, oldest first, with the effective direction.
 * Not user-scoped: for batch jobs only. UI code goes through lib/data.
 */
export async function loadClientMessagesForMetrics(clientId: string, windowDays: number): Promise<MetricMessage[]> {
  const db = createAdminSupabase()
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const [team, rows] = await Promise.all([
    getTeamNumbers(),
    fetchAll('loadClientMessagesForMetrics', (from, to) =>
      db
        .from('client_messages')
        .select('message_id, message_timestamp, direction, sender_phone, body')
        .eq('client_id', clientId)
        .gte('message_timestamp', since)
        .order('message_timestamp', { ascending: true })
        .order('message_id', { ascending: true })
        .range(from, to),
    ),
  ])
  return rows.map((r) => ({
    at: new Date(r.message_timestamp),
    direction: effectiveDirection(r, team),
    body: r.body ?? '',
  }))
}
