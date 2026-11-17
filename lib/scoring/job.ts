import 'server-only'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { serverEnv } from '@/lib/env'
import type { JobResult } from '@/lib/jobs/guard'
import type { Insert, Row } from '@/lib/db/types'
import { computeClientMetrics } from '@/lib/metrics'
import { chunk, fetchAll } from '@/lib/data/paginate'
import { isActiveClient } from '@/lib/data/client-status'
import { loadClientMessagesForMetrics } from '@/lib/metrics/load'
import {
  computeHealthScore,
  dateInTimezone,
  messageEvents,
  pickPrev,
  ticketEvents,
  weightsFromRows,
  type Contribution,
} from '@/lib/scoring'

const JOB = 'health-score'
const DEFAULT_SLA_MINUTES = 60

type ScoreRow = Insert<'client_scores'>
type HistoryRow = Insert<'client_score_history'>
type Computed = { client_id: string; score: ScoreRow; history: HistoryRow; contributions: Contribution[] }

/**
 * Daily health score for every client with a WhatsApp group (or just `clientIds`).
 * Dry-run (write false) computes and returns the rows in `details`; write mode upserts
 * client_scores (one row per client) and client_score_history (client_id + score_date in APP_TIMEZONE).
 */
export async function runHealthScoreJob(o: { write: boolean; now: Date; clientIds?: string[] }): Promise<JobResult> {
  const result: JobResult = { job: JOB, dryRun: !o.write, processed: 0, written: 0, errors: [] }
  const db = createAdminSupabase()
  const timezone = serverEnv().APP_TIMEZONE
  const now = o.now
  const scoreDate = dateInTimezone(now, timezone)

  const [weightsRes, slaRes] = await Promise.all([
    db.from('score_weights').select('key, value'),
    db.from('settings').select('value').eq('key', 'sla_minutes').maybeSingle(),
  ])
  if (weightsRes.error) throw new Error(`score_weights: ${weightsRes.error.message}`)
  if (slaRes.error) result.errors.push(`settings sla_minutes: ${slaRes.error.message}`)
  const weights = weightsFromRows(weightsRes.data ?? [])
  const slaParsed = Number.parseInt(slaRes.data?.value ?? '', 10)
  const slaMinutes = Number.isFinite(slaParsed) && slaParsed > 0 ? slaParsed : DEFAULT_SLA_MINUTES
  const windowDays = Math.max(1, Math.round(weights.window_days))

  let clientsQuery = db.from('clients').select('client_id, va_id, whatsapp_group_id, status')
  const named = Boolean(o.clientIds && o.clientIds.length > 0)
  clientsQuery = named ? clientsQuery.in('client_id', o.clientIds!) : clientsQuery.not('whatsapp_group_id', 'is', null)
  const clientsRes = await clientsQuery
  if (clientsRes.error) throw new Error(`clients: ${clientsRes.error.message}`)
  // The daily run scores active clients only (Inactive = churned or parked in HubSpot); named clients always run.
  const clients = (clientsRes.data ?? []).filter((c) => named || isActiveClient(c.status))
  if (clients.length === 0) return { ...result, details: { scoreDate, slaMinutes, weights, rows: [] } }
  const ids = clients.map((c) => c.client_id)

  const windowStart = new Date(now.getTime() - windowDays * 86_400_000).toISOString()
  // Tickets opened in the window plus every open ticket. Paged (PostgREST caps a read at 1000 rows) and
  // chunked by client id, so no client's tickets are dropped once the council has opened many.
  const loadConversations = async () => {
    const out = []
    for (const part of chunk(ids)) {
      out.push(
        ...(await fetchAll('conversations', (from, to) =>
          db
            .from('conversations')
            .select('id, client_id, tag, fault, status, opened_at, client_tone')
            .in('client_id', part)
            .or(`opened_at.gte.${windowStart},status.eq.open`)
            .order('id')
            .range(from, to),
        )),
      )
    }
    return out
  }
  const [scoresRes, convRows] = await Promise.all([
    db.from('client_scores').select('client_id, service_score, mood_score, prev_service, prev_mood, computed_at').in('client_id', ids),
    loadConversations(),
  ])
  if (scoresRes.error) throw new Error(`client_scores: ${scoresRes.error.message}`)

  const existing = new Map<string, Pick<Row<'client_scores'>, 'service_score' | 'mood_score' | 'prev_service' | 'prev_mood' | 'computed_at'>>()
  for (const s of scoresRes.data ?? []) existing.set(s.client_id, s)
  const convsByClient = new Map<string, typeof convRows>()
  for (const c of convRows) {
    const list = convsByClient.get(c.client_id) ?? []
    list.push(c)
    convsByClient.set(c.client_id, list)
  }

  const computed: Computed[] = []
  for (const client of clients) {
    try {
      const msgs = await loadClientMessagesForMetrics(client.client_id, windowDays)
      const metrics = computeClientMetrics(msgs, { now, timezone })
      const events = [...messageEvents(msgs, { now, slaMinutes, timezone }), ...ticketEvents(convsByClient.get(client.client_id) ?? [])]
      const prev = pickPrev(existing.get(client.client_id), now, timezone)
      const r = computeHealthScore({ metrics, events, weights, now, prev })
      const lastAt = msgs.reduce<Date | null>((max, m) => (!max || m.at > max ? m.at : max), null)
      const computedAt = now.toISOString()
      computed.push({
        client_id: client.client_id,
        score: {
          client_id: client.client_id,
          va_id: client.va_id,
          service_score: r.service_score,
          mood_score: r.mood_score,
          prev_service: r.prev_service,
          prev_mood: r.prev_mood,
          service_delta: r.service_delta,
          mood_delta: r.mood_delta,
          open_issues: r.open_issues,
          complaints_7d: r.complaints_7d,
          our_fault_7d: r.our_fault_7d,
          unanswered_count: r.unanswered_count,
          worst_lag_minutes: r.worst_lag_minutes === null ? null : Math.round(r.worst_lag_minutes),
          top_reasons: r.top_reasons,
          last_message_at: lastAt ? lastAt.toISOString() : null,
          computed_at: computedAt,
        },
        history: {
          client_id: client.client_id,
          score_date: scoreDate,
          service_score: r.service_score,
          mood_score: r.mood_score,
          open_issues: r.open_issues,
          complaints_7d: r.complaints_7d,
          our_fault_7d: r.our_fault_7d,
          computed_at: computedAt,
        },
        contributions: r.contributions,
      })
      result.processed += 1
    } catch (e) {
      result.errors.push(`${client.client_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (o.write && computed.length > 0) {
    const scoresUp = await db.from('client_scores').upsert(computed.map((c) => c.score), { onConflict: 'client_id' })
    if (scoresUp.error) {
      result.errors.push(`client_scores upsert: ${scoresUp.error.message}`)
      result.fatal = true
    } else {
      result.written = computed.length
      const histUp = await db
        .from('client_score_history')
        .upsert(computed.map((c) => c.history), { onConflict: 'client_id,score_date' })
      if (histUp.error) result.errors.push(`client_score_history upsert: ${histUp.error.message}`)
    }
  }

  result.details = { scoreDate, slaMinutes, windowDays, weights, rows: computed }
  return result
}
