import 'server-only'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { serverEnv } from '@/lib/env'
import type { JobResult } from '@/lib/jobs/guard'
import { chunk, fetchAll } from '@/lib/data/paginate'
import { BUCKET_STORAGE_APPROVED, getClientBucket } from '@/lib/buckets'
import { createHubspotClient, type HubspotClient, type HubspotDeal } from './client'
import {
  SHADOW_OWNED_PROPERTIES,
  STATUS_ACTIVE,
  buildShadowDealProperties,
  diffDealProperties,
  gateClientCreates,
  hubspotPullProperties,
  MAX_CREATES_PER_RUN,
  paidDateProperty,
  planDealPull,
  vaConfigFromEnv,
  type KnownClient,
  type LinkedClient,
  type VaConfig,
} from './mapping'
import { isActiveClient } from '@/lib/data/client-status'

/** Time of the last scheduled write run with no failed writes. Shown on Admin and Engineer; not a pull cursor. */
export const CURSOR_KEY = 'hubspot_last_sync'
const JOB = 'hubspot-sync'

type ClientRow = {
  client_id: string
  client_name: string
  hubspot_deal_id: string | null
  deal_stage: string | null
  amount_paid: number | null
  status: string | null
  va_id: string | null
  parent_client_id: string | null
}

type Db = ReturnType<typeof createAdminSupabase>

/**
 * HubSpot Deals sync (spec: specs/hubspot-sync-v2.md).
 *  1. Pull: every paid deal in the Virtual Accounting pipeline (or just `dealIds` from the webhook). Each run
 *     reconciles all of them, so a missed webhook heals on the next run. Linked clients get stage label,
 *     amount_paid and Active / Inactive; an active deal with no client creates one (at most MAX_CREATES_PER_RUN,
 *     and never when a client of a similar name exists: that goes to needsReview).
 *  2. Push: Shadow-owned va_* properties, only when HUBSPOT_PUSH_ENABLED=true (off: the properties do not exist yet).
 * Dry-run unless write is true: reads both sides, reports the plan, writes nothing.
 */
export async function runHubspotSync(o: { write: boolean; dealIds?: string[]; now?: Date }): Promise<JobResult> {
  const now = o.now ?? new Date()
  const result: JobResult = { job: JOB, dryRun: !o.write, processed: 0, written: 0, errors: [] }
  const warnings: string[] = []
  const fail = (msg: string) => {
    result.errors.push(msg)
    result.fatal = true
    return result
  }

  const env = serverEnv()
  if (!env.HUBSPOT_ACCESS_TOKEN) return fail('HUBSPOT_ACCESS_TOKEN is not set')
  const hubspot = createHubspotClient({ token: env.HUBSPOT_ACCESS_TOKEN })
  const db = createAdminSupabase()

  // Stage labels are required: clients store the label, never the id.
  let cfg: VaConfig
  try {
    const base = vaConfigFromEnv(process.env)
    cfg = { ...base, stageLabels: await hubspot.getPipelineStageLabels(base.pipelineId) }
    if (cfg.stageLabels.size === 0) return fail(`pipeline ${base.pipelineId} has no stages (wrong HUBSPOT_VA_PIPELINE_ID?)`)
  } catch (e) {
    return fail(`load pipeline stages: ${(e as Error).message}`)
  }

  let clients: ClientRow[]
  try {
    clients = await fetchAll('clients', (from, to) =>
      db
        .from('clients')
        .select('client_id, client_name, hubspot_deal_id, deal_stage, amount_paid, status, va_id, parent_client_id')
        .order('client_id')
        .range(from, to),
    )
  } catch (e) {
    return fail(`load clients: ${(e as Error).message}`)
  }
  const linked = new Map<string, LinkedClient>()
  for (const c of clients) if (c.hubspot_deal_id) linked.set(c.hubspot_deal_id, c)
  const known: KnownClient[] = clients.map((c) => ({ client_id: c.client_id, client_name: c.client_name }))

  const vaIdByOwnerId = await loadVaIdByOwnerId(hubspot, db, warnings)

  let deals: HubspotDeal[]
  const properties = hubspotPullProperties(cfg)
  try {
    deals = o.dealIds
      ? o.dealIds.length
        ? await hubspot.batchReadDeals(o.dealIds, properties)
        : []
      : await hubspot.searchDeals(
          [
            { propertyName: 'pipeline', operator: 'EQ', value: cfg.pipelineId },
            { propertyName: paidDateProperty(cfg), operator: 'HAS_PROPERTY' },
          ],
          properties,
        )
  } catch (e) {
    return fail(`pull: ${(e as Error).message}`)
  }
  result.processed += deals.length

  const plan = planDealPull(deals, linked, known, cfg, { vaIdByOwnerId, timezone: env.APP_TIMEZONE })

  // Active clients whose deal did not come back (deleted, moved pipeline, or never paid): reported, never changed.
  const pulledIds = new Set(deals.map((d) => d.id))
  const expectedIds = o.dealIds ?? [...linked.keys()]
  const missingDeals = clients
    .filter((c) => c.hubspot_deal_id && expectedIds.includes(c.hubspot_deal_id) && !pulledIds.has(c.hubspot_deal_id))
    .filter((c) => isActiveClient(c.status))
    .map((c) => ({ clientId: c.client_id, clientName: c.client_name, dealId: c.hubspot_deal_id as string }))
  if (missingDeals.length > 0) {
    warnings.push(
      `${missingDeals.length} active client(s) link to a deal that is not a paid VA deal any more (deleted, moved ` +
        'pipeline, or never paid). They were left as they are; check them by hand.',
    )
  }
  const gate = gateClientCreates(plan.creates)
  let failed = 0
  if (gate.held > 0) {
    failed++
    result.errors.push(
      `${gate.held} active VA deals with no client is more than the ${MAX_CREATES_PER_RUN} allowed per run, so none ` +
        'were created. Check the HUBSPOT_VA_* settings, or create these clients by hand.',
    )
  }
  if (plan.needsReview.length > 0) {
    warnings.push(
      `${plan.needsReview.length} active deal(s) have no linked client but a client with a similar name exists. ` +
        'Set hubspot_deal_id on the right client by hand; nothing was created for them.',
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

  // Push only for clients that stay linked and active after this run's pull.
  const statusAfter = new Map(plan.updates.map((u) => [u.clientId, u.patch.status]))
  const pushTargets = clients.filter(
    (c) =>
      c.hubspot_deal_id &&
      (!o.dealIds || o.dealIds.includes(c.hubspot_deal_id)) &&
      (statusAfter.get(c.client_id) ?? c.status) === STATUS_ACTIVE,
  )
  const push =
    process.env.HUBSPOT_PUSH_ENABLED?.trim().toLowerCase() === 'true'
      ? await pushDeals({ write: o.write, hubspot, db, clients: pushTargets, result })
      : { skipped: 'HUBSPOT_PUSH_ENABLED is not true (the va_* deal properties do not exist in HubSpot yet)' }

  // Recorded last, and only for a scheduled write run with no errors at all (pull or push).
  let lastSyncWritten = false
  if (o.write && !o.dealIds && failed === 0 && result.errors.length === 0) {
    const { error } = await db
      .from('settings')
      .upsert({ key: CURSOR_KEY, value: now.toISOString(), note: 'Last successful HubSpot sync (hubspot-sync job)' })
    if (error) result.errors.push(`write last sync time: ${error.message}`)
    else lastSyncWritten = true
  }

  result.details = {
    pull: {
      pipelineId: cfg.pipelineId,
      deals: deals.length,
      counts: plan.counts,
      updateCount: plan.updates.length,
      updates: plan.updates.slice(0, 100),
      createCount: plan.creates.length,
      creates: plan.creates.slice(0, 50),
      createsHeld: gate.held,
      needsReview: plan.needsReview,
      missingDeals,
      unchanged: plan.unchanged,
      lastSyncWritten,
    },
    push,
    bucketPushed: BUCKET_STORAGE_APPROVED,
    warnings,
  }
  return result
}

/**
 * HubSpot owner id -> accountant va_id, matched on email (vas.email). Only used to pre-fill the accountant of a
 * NEW client from the deal's AM Deal Owner. Failure is a warning: new clients are then left unassigned.
 */
async function loadVaIdByOwnerId(hubspot: HubspotClient, db: Db, warnings: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const [owners, vasRes] = await Promise.all([hubspot.listOwnerEmails(), db.from('vas').select('va_id, email')])
    if (vasRes.error) throw new Error(vasRes.error.message)
    const vaByEmail = new Map(
      (vasRes.data ?? []).filter((v) => v.email).map((v) => [String(v.email).trim().toLowerCase(), v.va_id]),
    )
    for (const [ownerId, email] of owners) {
      const vaId = vaByEmail.get(email)
      if (vaId) out.set(ownerId, vaId)
    }
  } catch (e) {
    warnings.push(`AM Deal Owner lookup failed, new clients stay unassigned: ${(e as Error).message}`)
  }
  return out
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
  // Push failures are partial errors, not fatal: the pull may already have written.
  try {
    openRows = await loadOpen()
  } catch (e) {
    result.errors.push(`push: load ${(e as Error).message}`)
    return { deals: 0, changes: [], changeCount: 0, missingInHubspot: [] as string[] }
  }
  for (const [name, r] of [['vas', vasRes], ['client_scores', scoresRes]] as const) {
    if (r.error) {
      result.errors.push(`push: load ${name}: ${r.error.message}`)
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
