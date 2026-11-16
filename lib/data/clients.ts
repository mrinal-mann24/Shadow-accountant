import 'server-only'
import type { AppUser } from '@/lib/auth/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { Row } from '@/lib/db/types'
import { chunk, fetchAll } from './paginate'
import { isActiveClient, matchesStatusFilter, type ClientStatusFilter } from './client-status'
import { assertCanMutate, isInvalidInput, scopeOf, type Db } from './scope'
import type { ClientDetail, ClientListItem, ContactItem, VaItem } from './types'

const CLIENT_COLS =
  'client_id, client_name, legal_name, status, deal_stage, va_id, whatsapp_group_name, council_enabled, parent_client_id'
const CLIENT_DETAIL_COLS = `${CLIENT_COLS}, email, gstin, entity_type, industry, city, state, onboarding_date, hubspot_deal_id, whatsapp_group_id`
const SCORE_COLS =
  'client_id, va_id, service_score, mood_score, service_delta, mood_delta, open_issues, complaints_7d, our_fault_7d, unanswered_count, worst_lag_minutes, top_reasons, computed_at, last_message_at'

type ClientBase = Pick<
  Row<'clients'>,
  | 'client_id'
  | 'client_name'
  | 'legal_name'
  | 'status'
  | 'deal_stage'
  | 'va_id'
  | 'whatsapp_group_name'
  | 'council_enabled'
  | 'parent_client_id'
>
type ScoreRow = Pick<
  Row<'client_scores'>,
  | 'client_id'
  | 'va_id'
  | 'service_score'
  | 'mood_score'
  | 'service_delta'
  | 'mood_delta'
  | 'open_issues'
  | 'complaints_7d'
  | 'our_fault_7d'
  | 'unanswered_count'
  | 'worst_lag_minutes'
  | 'top_reasons'
  | 'computed_at'
  | 'last_message_at'
>

export const OPEN_STATUS = 'open'
export const ESCALATION_TAG = 'escalation'

export function topReasons(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export async function loadVaNames(db: Db): Promise<Map<string, string>> {
  const { data, error } = await db.from('vas').select('va_id, va_name')
  if (error) throw new Error(`loadVaNames: ${error.message}`)
  return new Map((data ?? []).map((v) => [v.va_id, v.va_name]))
}

export async function loadScores(db: Db, clientIds: string[]): Promise<Map<string, ScoreRow>> {
  const out = new Map<string, ScoreRow>()
  for (const ids of chunk(clientIds)) {
    const rows = await fetchAll('loadScores', (from, to) =>
      db.from('client_scores').select(SCORE_COLS).in('client_id', ids).order('client_id').range(from, to),
    )
    for (const r of rows) out.set(r.client_id, r)
  }
  return out
}

const LAST_MESSAGE_CONCURRENCY = 30

/**
 * Latest message time per client, read live from client_messages (one indexed lookup per client on
 * client_id, message_timestamp desc). client_scores.last_message_at is only as fresh as the last score run.
 */
export async function loadLastMessageAt(db: Db, clientIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < clientIds.length; i += LAST_MESSAGE_CONCURRENCY) {
    const ids = clientIds.slice(i, i + LAST_MESSAGE_CONCURRENCY)
    const results = await Promise.all(
      ids.map((id) =>
        db
          .from('client_messages')
          .select('message_timestamp')
          .eq('client_id', id)
          .order('message_timestamp', { ascending: false })
          .limit(1),
      ),
    )
    results.forEach((res, j) => {
      if (res.error) throw new Error(`loadLastMessageAt: ${res.error.message}`)
      const at = res.data?.[0]?.message_timestamp
      if (at) out.set(ids[j], at)
    })
  }
  return out
}

/** Open ticket and open escalation counts per client. */
export async function loadOpenTicketCounts(
  db: Db,
  clientIds: string[],
): Promise<Map<string, { open: number; escalations: number }>> {
  const out = new Map<string, { open: number; escalations: number }>()
  for (const ids of chunk(clientIds)) {
    const rows = await fetchAll('loadOpenTicketCounts', (from, to) =>
      db
        .from('conversations')
        .select('id, client_id, tag')
        .in('client_id', ids)
        .eq('status', OPEN_STATUS)
        .order('id')
        .range(from, to),
    )
    for (const r of rows) {
      const c = out.get(r.client_id) ?? { open: 0, escalations: 0 }
      c.open++
      if (r.tag === ESCALATION_TAG) c.escalations++
      out.set(r.client_id, c)
    }
  }
  return out
}

function toListItem(
  c: ClientBase,
  vaNames: Map<string, string>,
  score: ScoreRow | undefined,
  tickets: { open: number; escalations: number } | undefined,
  lastMessageAt?: string,
): ClientListItem {
  return {
    id: c.client_id,
    name: c.client_name,
    legalName: c.legal_name,
    status: c.status,
    dealStage: c.deal_stage,
    vaId: c.va_id,
    vaName: c.va_id ? (vaNames.get(c.va_id) ?? null) : null,
    whatsappGroupName: c.whatsapp_group_name,
    councilEnabled: c.council_enabled,
    parentClientId: c.parent_client_id,
    serviceScore: score?.service_score ?? null,
    moodScore: score?.mood_score ?? null,
    serviceDelta: score?.service_delta ?? null,
    moodDelta: score?.mood_delta ?? null,
    scoreComputedAt: score?.computed_at ?? null,
    lastMessageAt: lastMessageAt ?? score?.last_message_at ?? null,
    unansweredCount: score?.unanswered_count ?? null,
    worstLagMinutes: score?.worst_lag_minutes ?? null,
    openTickets: tickets?.open ?? 0,
    openEscalations: tickets?.escalations ?? 0,
  }
}

async function enrich(db: Db, rows: ClientBase[]): Promise<ClientListItem[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.client_id)
  const [vaNames, scores, tickets, lastMessages] = await Promise.all([
    loadVaNames(db),
    loadScores(db, ids),
    loadOpenTicketCounts(db, ids),
    loadLastMessageAt(db, ids),
  ])
  return rows.map((r) =>
    toListItem(r, vaNames, scores.get(r.client_id), tickets.get(r.client_id), lastMessages.get(r.client_id)),
  )
}

export function matchesSearch(c: ClientBase, search: string): boolean {
  const s = search.trim().toLowerCase()
  if (!s) return true
  return [c.client_name, c.legal_name, c.whatsapp_group_name].some((v) => v?.toLowerCase().includes(s))
}

/**
 * Clients in the user's scope, sorted by name, with score and open ticket counts.
 * Active clients only by default (status from the HubSpot sync); `status: 'inactive' | 'all'` for history.
 */
export async function listClients(
  user: AppUser,
  f: { search?: string; vaId?: string; status?: ClientStatusFilter } = {},
): Promise<ClientListItem[]> {
  const scope = scopeOf(user)
  if (!scope.all && !scope.vaId) return []
  if (!scope.all && f.vaId && f.vaId !== scope.vaId) return []
  const vaFilter = scope.all ? f.vaId : scope.vaId
  const db = createAdminSupabase()
  const rows = await fetchAll('listClients', (from, to) => {
    let q = db.from('clients').select(CLIENT_COLS)
    if (vaFilter) q = q.eq('va_id', vaFilter)
    return q.order('client_name').order('client_id').range(from, to)
  })
  const statusFilter = f.status ?? 'active'
  const filtered = rows.filter(
    (r) => matchesStatusFilter(r.status, statusFilter) && (!f.search || matchesSearch(r, f.search)),
  )
  return enrich(db, filtered)
}

/** One client with profile, score, contacts and accountant name; null when missing or out of scope. */
export async function getClient(user: AppUser, clientId: string): Promise<ClientDetail | null> {
  const scope = scopeOf(user)
  if (!clientId || (!scope.all && !scope.vaId)) return null
  const db = createAdminSupabase()
  const { data: c, error } = await db.from('clients').select(CLIENT_DETAIL_COLS).eq('client_id', clientId).maybeSingle()
  if (error) {
    if (isInvalidInput(error)) return null
    throw new Error(`getClient: ${error.message}`)
  }
  if (!c || (!scope.all && c.va_id !== scope.vaId)) return null

  const [vaNames, scores, tickets, contactsRes] = await Promise.all([
    loadVaNames(db),
    loadScores(db, [clientId]),
    loadOpenTicketCounts(db, [clientId]),
    db
      .from('client_contacts')
      .select('contact_id, contact_name, role, whatsapp_number, is_primary')
      .eq('client_id', clientId)
      .order('contact_name'),
  ])
  if (contactsRes.error) throw new Error(`getClient: contacts: ${contactsRes.error.message}`)
  const contacts: ContactItem[] = (contactsRes.data ?? [])
    .map((r) => ({
      id: r.contact_id,
      name: r.contact_name,
      role: r.role,
      whatsappNumber: r.whatsapp_number,
      isPrimary: r.is_primary === true,
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  const score = scores.get(clientId)

  return {
    ...toListItem(c, vaNames, score, tickets.get(clientId)),
    email: c.email,
    gstin: c.gstin,
    entityType: c.entity_type,
    industry: c.industry,
    city: c.city,
    state: c.state,
    onboardingDate: c.onboarding_date,
    hubspotDealId: c.hubspot_deal_id,
    whatsappGroupId: c.whatsapp_group_id,
    topReasons: topReasons(score?.top_reasons),
    contacts,
  }
}

/** Accountants with their live client counts. Admin and engineer only; [] for anyone else. */
export async function listVas(user: AppUser): Promise<VaItem[]> {
  if (!scopeOf(user).all) return []
  const db = createAdminSupabase()
  const [vasRes, clients] = await Promise.all([
    db.from('vas').select('va_id, va_name, email, status').order('va_name'),
    fetchAll('listVas', (from, to) =>
      db.from('clients').select('client_id, va_id, status').order('client_id').range(from, to),
    ),
  ])
  if (vasRes.error) throw new Error(`listVas: ${vasRes.error.message}`)
  // Active clients only, so the count matches Home and the team overview.
  const counts = new Map<string, number>()
  for (const c of clients) if (c.va_id && isActiveClient(c.status)) counts.set(c.va_id, (counts.get(c.va_id) ?? 0) + 1)
  return (vasRes.data ?? []).map((v) => ({
    id: v.va_id,
    name: v.va_name,
    email: v.email,
    status: v.status,
    clientCount: counts.get(v.va_id) ?? 0,
  }))
}

/** Admin only. Sets clients.va_id (null unassigns). Throws ForbiddenError / Error('... not found'). */
export async function assignClient(user: AppUser, clientId: string, vaId: string | null): Promise<void> {
  assertCanMutate(user, ['admin'])
  const db = createAdminSupabase()
  if (vaId) {
    const { data, error } = await db.from('vas').select('va_id').eq('va_id', vaId).maybeSingle()
    if (error && !isInvalidInput(error)) throw new Error(`assignClient: ${error.message}`)
    if (!data) throw new Error('Accountant not found.')
  }
  const { data, error } = await db.from('clients').update({ va_id: vaId }).eq('client_id', clientId).select('client_id')
  if (error && !isInvalidInput(error)) throw new Error(`assignClient: ${error.message}`)
  if (!data || data.length === 0) throw new Error('Client not found.')
}

/** Engineer only. Turns the ticket council on or off for one client. */
export async function setCouncilEnabled(user: AppUser, clientId: string, enabled: boolean): Promise<void> {
  assertCanMutate(user, ['engineer'])
  const db = createAdminSupabase()
  const { data, error } = await db
    .from('clients')
    .update({ council_enabled: enabled })
    .eq('client_id', clientId)
    .select('client_id')
  if (error && !isInvalidInput(error)) throw new Error(`setCouncilEnabled: ${error.message}`)
  if (!data || data.length === 0) throw new Error('Client not found.')
}
