// Pure field mapping between Shadow Accounting clients and HubSpot Deals. One owner per field:
//   HubSpot owns: dealstage -> clients.deal_stage, amount -> clients.amount_paid (only when paid), deal won -> new client
//   Shadow owns:  va_bucket, va_accountant, va_health_score, va_open_tickets, va_open_escalations
// Nothing here writes the other side's fields, which (with diffing) keeps the sync free of loops.
import type { HubspotDeal } from './client'

export const SHADOW_OWNED_PROPERTIES = [
  'va_bucket',
  'va_accountant',
  'va_health_score',
  'va_open_tickets',
  'va_open_escalations',
] as const
export type ShadowOwnedProperty = (typeof SHADOW_OWNED_PROPERTIES)[number]

/** Deal properties we read when pulling HubSpot-owned fields. */
export const HUBSPOT_PULL_PROPERTIES = ['dealname', 'dealstage', 'amount', 'hs_lastmodifieddate'] as const

export type ShadowDealInput = {
  bucket: string | null
  vaName: string | null
  serviceScore: number | null
  openTickets: number
  openEscalations: number
}

/** Values Shadow wants on the deal. va_bucket is left out while bucket storage is not approved. */
export function buildShadowDealProperties(
  input: ShadowDealInput,
  opts: { includeBucket: boolean },
): Partial<Record<ShadowOwnedProperty, string>> {
  const props: Partial<Record<ShadowOwnedProperty, string>> = {
    va_accountant: input.vaName?.trim() ?? '',
    va_health_score: input.serviceScore === null ? '' : String(Math.round(input.serviceScore)),
    va_open_tickets: String(input.openTickets),
    va_open_escalations: String(input.openEscalations),
  }
  if (opts.includeBucket) props.va_bucket = input.bucket ?? ''
  return props
}

function norm(v: string | null | undefined): string {
  return (v ?? '').trim()
}

/** HubSpot returns empty as null and numbers as strings ("72" or "72.0"); treat those as equal. */
export function sameHubspotValue(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a)
  const y = norm(b)
  if (x === y) return true
  if (x === '' || y === '') return false
  const nx = Number(x)
  const ny = Number(y)
  return Number.isFinite(nx) && Number.isFinite(ny) && nx === ny
}

/** Only the properties whose desired value differs from what HubSpot already has. */
export function diffDealProperties(
  desired: Record<string, string>,
  current: Record<string, string | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(desired)) {
    if (!sameHubspotValue(value, current[key])) out[key] = value
  }
  return out
}

/** HUBSPOT_WON_STAGE_IDS is a comma list of deal stage ids. */
export function parseWonStageIds(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/** Parses HubSpot's amount string. Null when blank or not a number. */
export function parseAmount(raw: string | null | undefined): number | null {
  const v = norm(raw).replace(/,/g, '')
  if (v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** A deal counts as paid once it reaches a won stage (no separate payment property in the portal yet). */
export function isDealWon(deal: HubspotDeal, wonStageIds: Set<string>): boolean {
  const stage = norm(deal.properties.dealstage)
  return stage !== '' && wonStageIds.has(stage)
}

export type ClientDealFields = { deal_stage: string | null; amount_paid: number | null }

/** HubSpot-owned client fields that need changing for this deal (empty object when nothing changed). */
export function mapDealToClientPatch(
  deal: HubspotDeal,
  client: ClientDealFields,
  wonStageIds: Set<string>,
): Partial<ClientDealFields> {
  const patch: Partial<ClientDealFields> = {}
  const stage = norm(deal.properties.dealstage)
  if (stage !== '' && stage !== (client.deal_stage ?? '')) patch.deal_stage = stage
  if (isDealWon(deal, wonStageIds)) {
    const amount = parseAmount(deal.properties.amount)
    if (amount !== null && amount !== client.amount_paid) patch.amount_paid = amount
  }
  return patch
}

export type NewClientFromDeal = {
  client_name: string
  hubspot_deal_id: string
  deal_stage: string | null
  amount_paid: number | null
}

/** New client for a won deal. va_id stays empty so it shows up in Admin assignment. */
export function buildClientFromDeal(deal: HubspotDeal): NewClientFromDeal {
  const name = norm(deal.properties.dealname)
  return {
    client_name: name || `HubSpot deal ${deal.id}`,
    hubspot_deal_id: deal.id,
    deal_stage: norm(deal.properties.dealstage) || null,
    amount_paid: parseAmount(deal.properties.amount),
  }
}

export type PullPlan = {
  updates: { clientId: string; dealId: string; patch: Partial<ClientDealFields> }[]
  creates: NewClientFromDeal[]
  unchanged: number
  ignored: number // no client and not won
}

/** Decide what a batch of pulled deals does to clients. clientsByDealId: hubspot_deal_id -> client. */
export function planDealPull(
  deals: HubspotDeal[],
  clientsByDealId: Map<string, ClientDealFields & { client_id: string }>,
  wonStageIds: Set<string>,
): PullPlan {
  const plan: PullPlan = { updates: [], creates: [], unchanged: 0, ignored: 0 }
  const seen = new Set<string>()
  for (const deal of deals) {
    if (seen.has(deal.id)) continue
    seen.add(deal.id)
    const client = clientsByDealId.get(deal.id)
    if (client) {
      const patch = mapDealToClientPatch(deal, client, wonStageIds)
      if (Object.keys(patch).length > 0) plan.updates.push({ clientId: client.client_id, dealId: deal.id, patch })
      else plan.unchanged++
    } else if (isDealWon(deal, wonStageIds)) {
      plan.creates.push(buildClientFromDeal(deal))
    } else {
      plan.ignored++
    }
  }
  return plan
}

/** At most this many clients are created from won deals in one run. More means a stage id or filter is wrong. */
export const MAX_CREATES_PER_RUN = 10

/**
 * Decides which planned client creates may run (fails closed):
 *  - first sync (no cursor yet): none. The first pull reads every deal ever modified, so creating would add a
 *    client for every historical or non-VA won deal. That run seeds the cursor; later runs create only for
 *    deals modified after it.
 *  - more than `cap` creates: none, and the caller reports an error so a person checks HUBSPOT_WON_STAGE_IDS.
 */
export function gateClientCreates<T>(
  creates: T[],
  o: { firstRun: boolean; cap?: number },
): { allowed: T[]; held: number; reason: 'first_run' | 'over_cap' | null } {
  const cap = o.cap ?? MAX_CREATES_PER_RUN
  if (creates.length === 0) return { allowed: [], held: 0, reason: null }
  if (o.firstRun) return { allowed: [], held: creates.length, reason: 'first_run' }
  if (creates.length > cap) return { allowed: [], held: creates.length, reason: 'over_cap' }
  return { allowed: creates, held: 0, reason: null }
}
