import 'server-only'
import type { AppUser } from '@/lib/auth/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { loadScores, topReasons } from './clients'
import { fetchAll } from './paginate'
import { canAccessClient, scopedClientIds } from './scope'
import type { ScoreHistoryItem, ScoreItem } from './types'

/** Latest score per client in scope (optionally only `clientIds`). Unscored clients are left out. */
export async function getClientScores(user: AppUser, clientIds?: string[]): Promise<ScoreItem[]> {
  const db = createAdminSupabase()
  const allowed = await scopedClientIds(db, user)
  let ids: string[] | null
  if (clientIds) ids = allowed === null ? clientIds : clientIds.filter((id) => allowed.includes(id))
  else ids = allowed
  if (ids && ids.length === 0) return []

  const rows =
    ids === null
      ? await fetchAll('getClientScores', (from, to) =>
          db
            .from('client_scores')
            .select(
              'client_id, va_id, service_score, mood_score, service_delta, mood_delta, open_issues, complaints_7d, our_fault_7d, unanswered_count, worst_lag_minutes, top_reasons, computed_at, last_message_at',
            )
            .order('client_id')
            .range(from, to),
        )
      : [...(await loadScores(db, ids)).values()]

  return rows.map((r) => ({
    clientId: r.client_id,
    vaId: r.va_id,
    serviceScore: r.service_score,
    moodScore: r.mood_score,
    serviceDelta: r.service_delta,
    moodDelta: r.mood_delta,
    openIssues: r.open_issues,
    complaints7d: r.complaints_7d,
    ourFault7d: r.our_fault_7d,
    unansweredCount: r.unanswered_count,
    worstLagMinutes: r.worst_lag_minutes,
    topReasons: topReasons(r.top_reasons),
    computedAt: r.computed_at,
    lastMessageAt: r.last_message_at,
  }))
}

/** Daily score history for the last `days` days (by score_date), oldest first. [] when out of scope. */
export async function getScoreHistory(user: AppUser, clientId: string, days: number): Promise<ScoreHistoryItem[]> {
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, clientId))) return []
  const span = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : 30
  const since = new Date(Date.now() - span * 86_400_000).toISOString().slice(0, 10)
  const rows = await fetchAll('getScoreHistory', (from, to) =>
    db
      .from('client_score_history')
      .select('client_id, score_date, service_score, mood_score, open_issues, complaints_7d, our_fault_7d, computed_at')
      .eq('client_id', clientId)
      .gte('score_date', since)
      .order('score_date', { ascending: true })
      .order('computed_at', { ascending: true })
      .range(from, to),
  )
  return rows.map((r) => ({
    clientId: r.client_id,
    date: r.score_date,
    serviceScore: r.service_score,
    moodScore: r.mood_score,
    openIssues: r.open_issues,
    complaints7d: r.complaints_7d,
    ourFault7d: r.our_fault_7d,
    computedAt: r.computed_at,
  }))
}
