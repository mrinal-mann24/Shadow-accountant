import { describe, expect, it } from 'vitest'
import type { HubspotDeal } from './client'
import {
  buildClientFromDeal,
  buildShadowDealProperties,
  classifyDeal,
  cleanDealName,
  dateInZone,
  diffDealProperties,
  gateClientCreates,
  hubspotPullProperties,
  MAX_CREATES_PER_RUN,
  mapDealToClientPatch,
  parseAmount,
  parseIdList,
  planDealPull,
  sameHubspotValue,
  similarNames,
  stageLabel,
  vaConfigFromEnv,
} from './mapping'

const deal = (id: string, p: Record<string, string | null>): HubspotDeal => ({ id, properties: p })

describe('buildShadowDealProperties', () => {
  const input = { bucket: 'DC', vaName: ' Priya Sharma ', serviceScore: 71.6, openTickets: 3, openEscalations: 1 }

  it('maps Shadow fields to va_* strings and leaves out va_bucket while storage is not approved', () => {
    expect(buildShadowDealProperties(input, { includeBucket: false })).toEqual({
      va_accountant: 'Priya Sharma',
      va_health_score: '72',
      va_open_tickets: '3',
      va_open_escalations: '1',
    })
  })

  it('includes va_bucket when allowed', () => {
    expect(buildShadowDealProperties(input, { includeBucket: true }).va_bucket).toBe('DC')
  })

  it('uses empty strings for an unassigned client with no score', () => {
    const p = buildShadowDealProperties(
      { bucket: null, vaName: null, serviceScore: null, openTickets: 0, openEscalations: 0 },
      { includeBucket: true },
    )
    expect(p).toEqual({ va_bucket: '', va_accountant: '', va_health_score: '', va_open_tickets: '0', va_open_escalations: '0' })
  })
})

describe('diffDealProperties', () => {
  it('returns only properties that differ', () => {
    const desired = { va_accountant: 'Priya', va_health_score: '72', va_open_tickets: '3', va_open_escalations: '0' }
    const current = { va_accountant: 'Priya', va_health_score: '65', va_open_tickets: '3', va_open_escalations: '1' }
    expect(diffDealProperties(desired, current)).toEqual({ va_health_score: '72', va_open_escalations: '0' })
  })

  it('treats null and empty string as equal, and numeric formats as equal', () => {
    expect(diffDealProperties({ va_accountant: '', va_health_score: '72' }, { va_accountant: null, va_health_score: '72.0' })).toEqual({})
  })

  it('a second run after pushing produces no changes (no loops)', () => {
    const desired = { va_accountant: 'Priya', va_open_tickets: '2' }
    expect(diffDealProperties(desired, { ...desired })).toEqual({})
  })
})

describe('sameHubspotValue', () => {
  it('does not treat text that looks different as equal', () => {
    expect(sameHubspotValue('DC', 'DS')).toBe(false)
    expect(sameHubspotValue('0', '')).toBe(false)
    expect(sameHubspotValue(' DC ', 'DC')).toBe(true)
  })
})

// ---------------------------------------------------------------- VA rule (ids and names from the live portal, 16 Nov 2026)

const PIPE = '1534965463'
const PAID = 'hs_v2_date_entered_2462646003'
const LABELS = new Map([
  ['2462646003', 'Payment Done'],
  ['3668025064', 'Ready for Renewal'],
  ['3102360263', 'Renewal Done'],
  ['3128528610', 'Churned'],
  ['4080072411', 'AM Parked'],
  ['2460613316', 'Yet to reach out'],
])
const CFG = vaConfigFromEnv({ HUBSPOT_IGNORE_DEAL_IDS: '337128679127' }, LABELS)
const opts = { vaIdByOwnerId: new Map([['80276937', 'va-harshit']]), timezone: 'Asia/Kolkata' }

const va = (id: string, stage: string, p: Record<string, string | null> = {}) =>
  deal(id, { pipeline: PIPE, dealstage: stage, [PAID]: '2026-08-06T13:46:30.597Z', ...p })

describe('vaConfigFromEnv / parseIdList', () => {
  it('defaults to the live Virtual Accounting pipeline and its three active stages', () => {
    const c = vaConfigFromEnv({})
    expect(c.pipelineId).toBe(PIPE)
    expect(c.paidStageId).toBe('2462646003')
    expect([...c.activeStageIds]).toEqual(['2462646003', '3668025064', '3102360263'])
    expect(c.ignoreDealIds.size).toBe(0)
  })
  it('reads overrides and ignores blanks', () => {
    expect([...parseIdList(' 1, ,2 ,')]).toEqual(['1', '2'])
    expect([...vaConfigFromEnv({ HUBSPOT_VA_ACTIVE_STAGE_IDS: '9' }).activeStageIds]).toEqual(['9'])
  })
  it('reads the paid-date property and amount_paid, never the contract amount', () => {
    const props = hubspotPullProperties(CFG)
    expect(props).toContain(PAID)
    expect(props).toContain('amount_paid')
    expect(props).not.toContain('amount')
  })
})

describe('classifyDeal', () => {
  it('active: VA pipeline, paid once, stage Payment Done / Ready for Renewal / Renewal Done', () => {
    for (const s of ['2462646003', '3668025064', '3102360263']) expect(classifyDeal(va('1', s), CFG).kind).toBe('active')
  })
  it('inactive: paid once but now Churned or AM Parked', () => {
    expect(classifyDeal(va('1', '3128528610'), CFG).kind).toBe('inactive')
    expect(classifyDeal(va('1', '4080072411'), CFG).kind).toBe('inactive')
  })
  it('ignore: never paid, other pipeline, or on the ignore list (test deal)', () => {
    expect(classifyDeal(va('1', '2462646003', { [PAID]: null }), CFG)).toEqual({ kind: 'ignore', reason: 'never_paid' })
    expect(classifyDeal(va('1', '1002792578', { pipeline: '106069137' }), CFG)).toEqual({ kind: 'ignore', reason: 'other_pipeline' })
    expect(classifyDeal(va('337128679127', '3102360263'), CFG)).toEqual({ kind: 'ignore', reason: 'ignore_list' })
  })
})

describe('stageLabel / parseAmount / dateInZone / cleanDealName', () => {
  it('turns stage ids into labels and returns null for unknown stages', () => {
    expect(stageLabel(va('1', '3102360263'), CFG)).toBe('Renewal Done')
    expect(stageLabel(va('1', '999'), CFG)).toBeNull()
  })
  it('parses amounts', () => {
    expect(parseAmount('40000')).toBe(40000)
    expect(parseAmount('1,25,000.50')).toBe(125000.5)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
  })
  it('gives the date in IST', () => {
    expect(dateInZone('2026-10-30', 'Asia/Kolkata')).toBe('2026-10-30')
    expect(dateInZone('2026-10-29T20:00:00.000Z', 'Asia/Kolkata')).toBe('2026-10-30')
    expect(dateInZone('', 'Asia/Kolkata')).toBeNull()
    expect(dateInZone('nope', 'Asia/Kolkata')).toBeNull()
  })
  it('strips the VA / AiA suffixes used in deal names', () => {
    expect(cleanDealName('Ayurpet <> VA')).toBe('Ayurpet')
    expect(cleanDealName('Rare you<>AIA')).toBe('Rare you')
    expect(cleanDealName('RapidFix_VA')).toBe('RapidFix')
    expect(cleanDealName('Down The Rabbit Hole_ VA')).toBe('Down The Rabbit Hole')
    expect(cleanDealName('Nyutech[Kiran]_AiA_2026')).toBe('Nyutech[Kiran]')
    expect(cleanDealName('Sanjib <> Virtual Accounting')).toBe('Sanjib')
    expect(cleanDealName('KRRD')).toBe('KRRD')
  })
})

describe('mapDealToClientPatch', () => {
  const client = { deal_stage: 'Payment Done', amount_paid: 40000, status: 'Active' }

  it('writes the stage label, not the id', () => {
    expect(mapDealToClientPatch(va('1', '3102360263', { amount_paid: '40000', amount: '80000' }), client, CFG)).toEqual({
      deal_stage: 'Renewal Done',
    })
  })
  it('marks a churned client Inactive', () => {
    expect(mapDealToClientPatch(va('1', '3128528610', { amount_paid: '40000' }), client, CFG)).toEqual({
      deal_stage: 'Churned',
      status: 'Inactive',
    })
  })
  it('copies amount_paid, never the contract amount', () => {
    expect(mapDealToClientPatch(va('1', '2462646003', { amount_paid: '45000', amount: '75000' }), client, CFG)).toEqual({
      amount_paid: 45000,
    })
  })
  it('never blanks a field and leaves non-VA deals alone', () => {
    expect(mapDealToClientPatch(va('1', '999', { amount_paid: '' }), { ...client, status: 'Inactive' }, CFG)).toEqual({})
    expect(mapDealToClientPatch(va('1', '2462646003', { pipeline: 'other' }), { ...client, status: null }, CFG)).toEqual({})
  })
  it('a second run after applying the patch changes nothing', () => {
    const d = va('1', '3128528610', { amount_paid: '9000' })
    const after = { ...client, ...mapDealToClientPatch(d, client, CFG) }
    expect(mapDealToClientPatch(d, after, CFG)).toEqual({})
  })
})

describe('buildClientFromDeal', () => {
  it('builds an Active client with label, paid amount, first payment date and the AM as accountant', () => {
    const d = va('353849235153', '2462646003', {
      dealname: 'wishtrailz <> VA',
      amount_paid: '14000',
      va_1st_payment_date: '2026-10-21',
      am_deal_owner: '80276937',
    })
    expect(buildClientFromDeal(d, CFG, opts)).toEqual({
      client_name: 'wishtrailz',
      hubspot_deal_id: '353849235153',
      deal_stage: 'Payment Done',
      amount_paid: 14000,
      onboarding_date: '2026-10-21',
      status: 'Active',
      va_id: 'va-harshit',
    })
  })
  it('leaves the accountant empty when the AM is unknown, and falls back to the paid date', () => {
    const c = buildClientFromDeal(va('9', '2462646003', { dealname: 'Azam <> AIA', am_deal_owner: '1' }), CFG, opts)
    expect(c.va_id).toBeNull()
    expect(c.onboarding_date).toBe('2026-08-06')
    expect(c.client_name).toBe('Azam')
  })
})

describe('similarNames', () => {
  it('matches the same client written differently, not unrelated names', () => {
    expect(similarNames('Forelife Health Systems Private Limited', 'Forelife Health Systems')).toBe(true)
    expect(similarNames('AJ METALWARE', 'aj metalware')).toBe(true)
    expect(similarNames('KRRD', 'Horizon Marketing')).toBe(false)
    expect(similarNames('AB', 'ABC')).toBe(false)
  })
})

describe('planDealPull', () => {
  const linked = new Map([
    ['340489293516', { client_id: 'c-forelife', deal_stage: 'Payment Done', amount_paid: 40000, status: 'Active' }],
    ['325115369196', { client_id: 'c-shaunak', deal_stage: 'Payment Done', amount_paid: 17000, status: 'Active' }],
    ['329950833363', { client_id: 'c-horizon', deal_stage: 'Renewal Done', amount_paid: 33000, status: 'Active' }],
  ])
  const unlinked = [
    { client_id: 'c-mrinal', client_name: 'MRINAL' },
    { client_id: 'c-krrd-old', client_name: 'KRRD Group' },
  ]
  const deals = [
    va('340489293516', '3102360263', { amount_paid: '40000' }), // Forelife: stage moved to Renewal Done
    va('325115369196', '3128528610', { amount_paid: '17000' }), // Shaunak: churned
    va('329950833363', '3102360263', { amount_paid: '33000' }), // Horizon: no change
    va('353849235153', '2462646003', { dealname: 'wishtrailz <> VA' }), // active, no client: create
    va('349767223019', '2462646003', { dealname: 'KRRD <> VA' }), // active, similar unlinked name: review
    va('111', '3128528610', { dealname: 'Old churned <> VA' }), // churned, no client: nothing
    va('337128679127', '3102360263', { dealname: 'Tester Mrinal coder <> VA' }), // ignore list
    va('222', '2460613316', { [PAID]: null }), // never paid
    va('340489293516', '3102360263'), // duplicate deal in the batch
  ]

  it('updates, marks churned Inactive, creates only for active deals, and holds look-alikes for review', () => {
    const plan = planDealPull(deals, linked, unlinked, CFG, opts)
    expect(plan.updates).toEqual([
      { clientId: 'c-forelife', dealId: '340489293516', patch: { deal_stage: 'Renewal Done' } },
      { clientId: 'c-shaunak', dealId: '325115369196', patch: { deal_stage: 'Churned', status: 'Inactive' } },
    ])
    expect(plan.unchanged).toBe(1)
    expect(plan.creates.map((c) => c.hubspot_deal_id)).toEqual(['353849235153'])
    expect(plan.needsReview).toEqual([
      { dealId: '349767223019', dealName: 'KRRD <> VA', clientId: 'c-krrd-old', clientName: 'KRRD Group' },
    ])
    expect(plan.counts).toEqual({ active: 4, inactive: 2, ignored: { ignore_list: 1, other_pipeline: 0, never_paid: 1 } })
  })
})

describe('planDealPull duplicate checks', () => {
  it('sends a second deal for an already linked client to review, not create', () => {
    const linked = new Map([['old', { client_id: 'c-rapid', deal_stage: 'Renewal Done', amount_paid: 1, status: 'Active' }]])
    const known = [{ client_id: 'c-rapid', client_name: 'RapidFix' }]
    const plan = planDealPull([va('new', '2462646003', { dealname: 'RapidFix_VA' })], linked, known, CFG, opts)
    expect(plan.creates).toEqual([])
    expect(plan.needsReview).toEqual([{ dealId: 'new', dealName: 'RapidFix_VA', clientId: 'c-rapid', clientName: 'RapidFix' }])
  })
  it('creates only the first of two similar new deals in one run', () => {
    const deals = [va('a', '2462646003', { dealname: 'Acme Foods <> VA' }), va('b', '2462646003', { dealname: 'Acme Foods_VA' })]
    const plan = planDealPull(deals, new Map(), [], CFG, opts)
    expect(plan.creates.map((c) => c.hubspot_deal_id)).toEqual(['a'])
    expect(plan.needsReview).toEqual([{ dealId: 'b', dealName: 'Acme Foods_VA', clientId: null, clientName: 'Acme Foods' }])
  })
  it('never writes a stage id when the stage has no label', () => {
    const client = { deal_stage: 'Payment Done', amount_paid: null, status: 'Active' }
    const patch = mapDealToClientPatch(va('1', '4999999999'), client, CFG)
    expect(patch.deal_stage).toBeUndefined()
    expect(JSON.stringify(patch)).not.toContain('4999999999')
  })
})

describe('gateClientCreates', () => {
  it('allows up to the cap and creates nothing above it', () => {
    expect(gateClientCreates([1, 2, 3])).toEqual({ allowed: [1, 2, 3], held: 0 })
    const many = Array.from({ length: MAX_CREATES_PER_RUN + 1 }, (_, i) => i)
    expect(gateClientCreates(many)).toEqual({ allowed: [], held: MAX_CREATES_PER_RUN + 1 })
  })
})
