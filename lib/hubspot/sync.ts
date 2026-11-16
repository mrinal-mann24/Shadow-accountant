import 'server-only'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { serverEnv } from '@/lib/env'
import type { JobResult } from '@/lib/jobs/guard'
import { chunk, fetchAll } from '@/lib/data/paginate'
import { BUCKET_STORAGE_APPROVED, getClientBucket } from '@/lib/buckets'
import { createHubspotClient, type HubspotClient, type HubspotDeal } from './client'
import {
  HUBSPOT_PULL_PROPERTIES,
  SHADOW_OWNED_PROPERTIES,
  buildShadowDealProperties,
  diffDealProperties,
  gateClientCreates,
  MAX_CREATES_PER_RUN,
  parseWonStageIds,
  planDealPull,
} from './mapping'

export const CURSOR_KEY = 'hubspot_last_sync'
const JOB = 'hubspot-sync'

type ClientRow = {
  client_id: string
  hubspot_deal_id: string | null
  deal_stage: string | null
  amount_paid: number | null
  va_id: string | null
}

/**
 * Two-way HubSpot Deals sync.
 *  1. Pull: deals modified since settings 'hubspot_last_sync' (or just `dealIds` from a webhook) update
 *     clients.deal_stage / amount_paid; a won deal with no client creates one, except on the first sync (no
 *     cursor yet: updates only, the run seeds the cursor) and never more than MAX_CREATES_PER_RUN per run.
 *  2. Push: Shadow-owned va_* properties, only where HubSpot's current value differs.
 * Dry-run unless write is true: reads both sides, reports the plan, writes nothing (cursor included).
 */
export async function runHubspotSync(o: { write: boolean; dealIds?: string[]; now?: Date }): Promise<JobResult> {
  const now = o.now ?? new Date()
  const result: JobResult = { job: JOB, dryRun: !o.write, processed: 0, written: 0, errors: [] }

  const token = serverEnv().HUBSPOT_ACCESS_TOKEN
  if (!token) {
    result.errors.push('HUBSPOT_ACCESS_TOKEN is not set')
    result.fatal = true
    return result
  }
  const hubspot = createHubspotClient({ token })
  const db = createAdminSupabase()
  const wonStageIds = parseWonStageIds(process.env.HUBSPOT_WON_STAGE_IDS)
  const warnings: string[] = []
  if (wonStageIds.size === 0) warnings.push('HUBSPOT_WON_STAGE_IDS is not set: amounts and new clients are skipped')

  const { data: clientData, error: clientErr } = await db
    .from('clients')
    .select('client_id, hubspot_deal_id, deal_stage, amount_paid, va_id')
    .not('hubspot_deal_id', 'is', null)
  if (clientErr) {
    result.errors.push(`load clients: ${clientErr.message}`)
    result.fatal = true
    return result
  }
  const clients = (clientData ?? []) as ClientRow[]
  const clientsByDealId = new Map(clients.map((c) => [c.hubspot_deal_id as string, c]))

  const pull = await pullDeals({ o, now, hubspot, db, wonStageIds, clientsByDealId, result, warnings })
  const pushTargets = o.dealIds ? clients.filter((c) => o.dealIds!.includes(c.hubspot_deal_id as string)) : clients
  const push = await pushDeals({ write: o.write, hubspot, db, clients: pushTargets, result })

  result.details = { pull, push, bucketPushed: BUCKET_STORAGE_APPROVED, warnings }
  return result
}

type Db = ReturnType<typeof createAdminSupabase>

async function pullDeals(a: {
  o: { write: boolean; dealIds?: string[] }
  now: Date
  hubspot: HubspotClient
  db: Db
  wonStageIds: Set<string>
  clientsByDealId: Map<string, ClientRow>
  result: JobResult
  warnings: string[]
}) {
  const { o, hubspot, db, result } = a
  const properties = [...HUBSPOT_PULL_PROPERTIES]
  let since: Date | null = null
  let deals: HubspotDeal[]
  try {
    // The cursor is read for the webhook too: with no cursor yet (first sync not run), nothing is created.
    const { data: cursor, error } = await db.from('settings').select('value').eq('key', CURSOR_KEY).maybeSingle()
    if (error) throw new Error(`read cursor: ${error.message}`)
    const parsed = cursor?.value ? new Date(cursor.value) : null
    since = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
    if (o.dealIds) {
      deals = o.dealIds.length ? await hubspot.batchReadDeals(o.dealIds, properties) : []
    } else {
      deals = await hubspot.searchDealsModifiedSince(since, properties)
    }
  } catch (e) {
    result.errors.push(`pull: ${(e as Error).message}`)
    result.fatal = true
    return { since: since?.toISOString() ?? null, deals: 0, cursorWritten: false }
  }

  result.processed += deals.length
  const plan = planDealPull(deals, a.clientsByDealId, a.wonStageIds)
  const gate = gateClientCreates(plan.creates, { firstRun: since === null })
  let failed = 0
  if (gate.reason === 'first_run') {
    a.warnings.push(
      `First sync (no cursor yet): ${gate.held} won deals with no client were not created. A write run seeds the ` +
        'cursor; later runs create clients only for deals modified after it. Add any real ones by hand.',
    )
  } else if (gate.reason === 'over_cap') {
    // Counts as a failed write, so the cursor does not move and the error repeats until someone checks.
    failed++
    result.errors.push(
      `${gate.held} won deals with no client is more than the ${MAX_CREATES_PER_RUN} allowed per run, so none were ` +
        'created. Check HUBSPOT_WON_STAGE_IDS (a shared stage such as closedwon matches non-VA deals).',
    )
  }

  if (o.write) {
    for (const u of plan.updates) {
      const { error } = await db.from('clients').update(u.patch).eq('client_id', u.clientId)
      if (error) {
        failed++
        result.errors.push(`update client ${u.clientId}: ${error.message}`)
      } else result.written++
    }
    for (const c of gate.allowed) {
      const { error } = await db.from('clients').insert(c)
      // 23505: another run (or the webhook) created this deal's client first; hubspot_deal_id is unique
      if (error && error.code !== '23505') {
        failed++
        result.errors.push(`create client for deal ${c.hubspot_deal_id}: ${error.message}`)
      } else if (!error) result.written++
    }
  }

  // Cursor moves only in write mode, only for the scheduled pull, and only when every write succeeded.
  let cursorWritten = false
  if (o.write && !o.dealIds && failed === 0) {
    const { error } = await db
      .from('settings')
      .upsert({ key: CURSOR_KEY, value: a.now.toISOString(), note: 'HubSpot deal sync cursor (hubspot-sync job)' })
    if (error) result.errors.push(`write cursor: ${error.message}`)
    else cursorWritten = true
  }

  return {
    since: since?.toISOString() ?? null,
    deals: deals.length,
    updates: plan.updates.slice(0, 50),
    creates: plan.creates.slice(0, 50),
    updateCount: plan.updates.length,
    createCount: plan.creates.length,
    createsHeld: gate.held,
    createsHeldReason: gate.reason,
    unchanged: plan.unchanged,
    ignored: plan.ignored,
    cursorWritten,
  }
}

async function pushDeals(a: { write: boolean; hubspot: HubspotClient; db: Db; clients: ClientRow[]; result: JobResult }) {
  const { hubspot, db, clients, result } = a
  if (clients.length === 0) return { deals: 0, changes: [], changeCount: 0, missingInHubspot: [] as string[] }
  const clientIds = clients.map((c) => c.client_id)

  // Open tickets are paged (PostgREST caps a read at 1000 rows) and chunked by client id.
  const loadOpen = async () => {
    const out: { id: string; client_id: string; tag: string | null }[] = []
    for (const part of chunk(clientIds)) {
      out.push(
        ...(await fetchAll('conversations', (from, to) =>
          db.from('conversations').select('id, client_id, tag').eq('status', 'open').in('client_id', part).order('id').range(from, to),
        )),
      )
    }
    return out
  }
  let openRows: { id: string; client_id: string; tag: string | null }[]
  const [vasRes, scoresRes] = await Promise.all([
    db.from('vas').select('va_id, va_name'),
    db.from('client_scores').select('client_id, service_score').in('client_id', clientIds),
  ])
  try {
    openRows = await loadOpen()
  } catch (e) {
    result.errors.push(`push: load ${(e as Error).message}`)
    result.fatal = true
    return { deals: 0, changes: [], changeCount: 0, missingInHubspot: [] as string[] }
  }
  for (const [name, r] of [['vas', vasRes], ['client_scores', scoresRes]] as const) {
    if (r.error) {
      result.errors.push(`push: load ${name}: ${r.error.message}`)
      result.fatal = true
      return { deals: 0, changes: [], changeCount: 0, missingInHubspot: [] as string[] }
    }
  }
  const vaName = new Map((vasRes.data ?? []).map((v) => [v.va_id, v.va_name]))
  const score = new Map((scoresRes.data ?? []).map((s) => [s.client_id, s.service_score]))
  const open = new Map<string, { tickets: number; escalations: number }>()
  for (const c of openRows) {
    const n = open.get(c.client_id) ?? { tickets: 0, escalations: 0 }
    n.tickets++
    if (c.tag === 'escalation') n.escalations++
    open.set(c.client_id, n)
  }

  let current: HubspotDeal[]
  try {
    current = await hubspot.batchReadDeals(
      clients.map((c) => c.hubspot_deal_id as string),
      [...SHADOW_OWNED_PROPERTIES],
    )
  } catch (e) {
    result.errors.push(`push: read deals: ${(e as Error).message}`)
    return { deals: 0, changes: [], changeCount: 0, missingInHubspot: [] as string[] }
  }
  const currentById = new Map(current.map((d) => [d.id, d.properties]))

  const changes: { id: string; clientId: string; properties: Record<string, string> }[] = []
  const missingInHubspot: string[] = []
  for (const c of clients) {
    const dealId = c.hubspot_deal_id as string
    const props = currentById.get(dealId)
    if (!props) {
      missingInHubspot.push(dealId)
      continue
    }
    const counts = open.get(c.client_id) ?? { tickets: 0, escalations: 0 }
    const desired = buildShadowDealProperties(
      {
        bucket: BUCKET_STORAGE_APPROVED ? await getClientBucket(c.client_id) : null,
        vaName: c.va_id ? (vaName.get(c.va_id) ?? null) : null,
        serviceScore: score.get(c.client_id) ?? null,
        openTickets: counts.tickets,
        openEscalations: counts.escalations,
      },
      { includeBucket: BUCKET_STORAGE_APPROVED },
    )
    const diff = diffDealProperties(desired as Record<string, string>, props)
    if (Object.keys(diff).length > 0) changes.push({ id: dealId, clientId: c.client_id, properties: diff })
  }
  result.processed += clients.length

  if (a.write && changes.length > 0) {
    try {
      const res = await hubspot.batchUpdateDeals(changes.map(({ id, properties }) => ({ id, properties })))
      result.written += res.updated
      for (const err of res.errors) result.errors.push(`push: update deals: ${err}`)
    } catch (e) {
      result.errors.push(`push: update deals: ${(e as Error).message}`)
    }
  }
  return { deals: clients.length, changes: changes.slice(0, 50), changeCount: changes.length, missingInHubspot }
}
