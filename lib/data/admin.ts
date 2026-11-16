import 'server-only'
import type { AppUser } from '@/lib/auth/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getTeamNumbers } from '@/lib/team'
import { ESCALATION_TAG, listClients } from './clients'
import { listConversations } from './conversations'
import { fetchAll } from './paginate'
import { assertCanMutate, isInvalidInput, requireRole } from './scope'
import type {
  AccountantWorkload,
  ClientListItem,
  ConversationItem,
  CouncilUsageReport,
  SystemHealth,
  TeamOverview,
} from './types'
import { summariseVerdicts } from './usage'

export const PROCESSING_PENDING = 'pending'
export const PROCESSING_FAILED = 'failed'
/** Same key as CURSOR_KEY in lib/hubspot/sync.ts (not imported, to keep lib/data free of the HubSpot client). */
export const HUBSPOT_LAST_SYNC_KEY = 'hubspot_last_sync'

type VaLite = { va_id: string; va_name: string; status: string | null }

/** Pure aggregation behind getTeamOverview (exported for tests). Workload follows clients.va_id. */
export function buildTeamOverview(
  vas: VaLite[],
  clients: ClientListItem[],
  openTickets: ConversationItem[],
  hubspotLastSync: string | null = null,
): TeamOverview {
  const vaOfClient = new Map(clients.map((c) => [c.id, c.vaId]))
  const accountants: AccountantWorkload[] = vas.map((v) => {
    const mine = clients.filter((c) => c.vaId === v.va_id)
    const scored = mine.filter((c) => c.serviceScore !== null)
    const myTickets = openTickets.filter((t) => vaOfClient.get(t.clientId) === v.va_id)
    const avg = scored.length
      ? Math.round((scored.reduce((s, c) => s + (c.serviceScore ?? 0), 0) / scored.length) * 10) / 10
      : null
    return {
      vaId: v.va_id,
      name: v.va_name,
      status: v.status,
      clientCount: mine.length,
      openTickets: myTickets.length,
      openEscalations: myTickets.filter((t) => t.tag === ESCALATION_TAG).length,
      slaBreachedOpen: myTickets.filter((t) => t.slaBreached).length,
      unansweredClients: mine.filter((c) => (c.unansweredCount ?? 0) > 0).length,
      avgServiceScore: avg,
    }
  })
  accountants.sort((a, b) => b.clientCount - a.clientCount || a.name.localeCompare(b.name))
  return {
    accountants,
    unassignedClients: clients.filter((c) => !c.vaId).length,
    escalations: openTickets.filter((t) => t.tag === ESCALATION_TAG),
    lowestHealth: clients
      .filter((c) => c.serviceScore !== null)
      .sort((a, b) => (a.serviceScore ?? 0) - (b.serviceScore ?? 0) || a.name.localeCompare(b.name))
      .slice(0, 10),
    hubspotLastSync,
  }
}

/** Admin and engineer (not while viewing as). Throws ForbiddenError otherwise. */
export async function getTeamOverview(user: AppUser): Promise<TeamOverview> {
  requireRole(user, ['admin', 'engineer'])
  const db = createAdminSupabase()
  const [vasRes, clients, open, hubspot] = await Promise.all([
    db.from('vas').select('va_id, va_name, status').order('va_name'),
    listClients(user),
    listConversations(user, { status: 'open' }),
    db.from('settings').select('value').eq('key', HUBSPOT_LAST_SYNC_KEY).maybeSingle(),
  ])
  if (vasRes.error) throw new Error(`getTeamOverview: ${vasRes.error.message}`)
  if (hubspot.error) throw new Error(`getTeamOverview: hubspot last sync: ${hubspot.error.message}`)
  return buildTeamOverview(vasRes.data ?? [], clients, open, hubspot.data?.value ?? null)
}

/** Engineer only (not while viewing as). Throws ForbiddenError otherwise. */
export async function getSystemHealth(user: AppUser): Promise<SystemHealth> {
  requireRole(user, ['engineer'])
  const db = createAdminSupabase()
  const since24h = new Date(Date.now() - 86_400_000).toISOString()
  const [lastMsg, count24h, pending, failed, failures, lastScore, council, hubspot, lastVerdict, team] = await Promise.all([
    db.from('client_messages').select('message_timestamp').order('message_timestamp', { ascending: false }).limit(1),
    db.from('client_messages').select('message_id', { count: 'exact', head: true }).gte('message_timestamp', since24h),
    db.from('message_processing_log').select('message_id', { count: 'exact', head: true }).eq('status', PROCESSING_PENDING),
    db.from('message_processing_log').select('message_id', { count: 'exact', head: true }).eq('status', PROCESSING_FAILED),
    db
      .from('message_processing_log')
      .select('message_id, status, error, attempts, max_attempts, created_at, processed_at')
      .eq('status', PROCESSING_FAILED)
      .order('created_at', { ascending: false })
      .limit(20),
    db.from('client_scores').select('computed_at').order('computed_at', { ascending: false }).limit(1),
    db.from('clients').select('client_id, client_name').eq('council_enabled', true).order('client_name'),
    db.from('settings').select('value').eq('key', HUBSPOT_LAST_SYNC_KEY).maybeSingle(),
    db.from('council_verdicts').select('created_at').order('created_at', { ascending: false }).limit(1),
    getTeamNumbers(),
  ])
  for (const [name, res] of [
    ['last message', lastMsg],
    ['messages 24h', count24h],
    ['pending', pending],
    ['failed', failed],
    ['failures', failures],
    ['last score', lastScore],
    ['council clients', council],
    ['hubspot last sync', hubspot],
    ['last council verdict', lastVerdict],
  ] as const) {
    if (res.error) throw new Error(`getSystemHealth: ${name}: ${res.error.message}`)
  }
  // Council backlog: messages from council-enabled clients the council has not processed yet.
  const councilIds = (council.data ?? []).map((c) => c.client_id)
  let councilBacklog = 0
  if (councilIds.length > 0) {
    const backlog = await db
      .from('client_messages')
      .select('message_id', { count: 'exact', head: true })
      .in('client_id', councilIds)
      .is('processed_at', null)
    if (backlog.error) throw new Error(`getSystemHealth: council backlog: ${backlog.error.message}`)
    councilBacklog = backlog.count ?? 0
  }
  return {
    lastMessageAt: lastMsg.data?.[0]?.message_timestamp ?? null,
    messagesLast24h: count24h.count ?? 0,
    processing: {
      pending: pending.count ?? 0,
      councilBacklog,
      failed: failed.count ?? 0,
      recentFailures: (failures.data ?? []).map((r) => ({
        messageId: r.message_id,
        status: r.status,
        error: r.error,
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
        createdAt: r.created_at,
        processedAt: r.processed_at,
      })),
    },
    lastScoreRunAt: lastScore.data?.[0]?.computed_at ?? null,
    councilClients: (council.data ?? []).map((c) => ({ id: c.client_id, name: c.client_name })),
    teamNumbersCount: team.size,
    hubspotLastSync: hubspot.data?.value ?? null,
    lastCouncilVerdictAt: lastVerdict.data?.[0]?.created_at ?? null,
  }
}

/** Engineer only (not while viewing as), read-only: council_verdicts counts and latencies for the AI usage card. */
export async function getCouncilUsage(user: AppUser, windowDays = 30): Promise<CouncilUsageReport> {
  requireRole(user, ['engineer'])
  const db = createAdminSupabase()
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const [rows, total, latest] = await Promise.all([
    fetchAll(
      'getCouncilUsage',
      (from, to) =>
        db
          .from('council_verdicts')
          .select('created_at, agreed, final_decision, claude_model, claude_latency_ms, gpt_model, gpt_latency_ms')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      { maxRows: 20_000 },
    ),
    db.from('council_verdicts').select('id', { count: 'exact', head: true }),
    db.from('council_verdicts').select('created_at').order('created_at', { ascending: false }).limit(1),
  ])
  if (total.error) throw new Error(`getCouncilUsage: total: ${total.error.message}`)
  if (latest.error) throw new Error(`getCouncilUsage: latest: ${latest.error.message}`)
  return {
    ...summariseVerdicts(rows, windowDays),
    totalVerdicts: total.count ?? 0,
    lastVerdictEverAt: latest.data?.[0]?.created_at ?? null,
  }
}

/**
 * Engineer only (not while viewing as). Puts a message_processing_log row back to 'pending' so the
 * council picks it up again. attempts and error are left as they are (history).
 */
export async function retryProcessing(user: AppUser, messageId: string): Promise<void> {
  assertCanMutate(user, ['engineer'])
  const db = createAdminSupabase()
  const { data, error } = await db
    .from('message_processing_log')
    .update({ status: PROCESSING_PENDING })
    .eq('message_id', messageId)
    .select('message_id')
  if (error && !isInvalidInput(error)) throw new Error(`retryProcessing: ${error.message}`)
  if (!data || data.length === 0) throw new Error('Processing record not found.')
}
