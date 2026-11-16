import { describe, expect, it } from 'vitest'
import type { HubspotDeal } from './client'
import {
  buildClientFromDeal,
  buildShadowDealProperties,
  diffDealProperties,
  gateClientCreates,
  MAX_CREATES_PER_RUN,
  mapDealToClientPatch,
  parseAmount,
  parseWonStageIds,
  planDealPull,
  sameHubspotValue,
} from './mapping'

const WON = parseWonStageIds('closedwon, 12345 ,')
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

  it('pushes a value when HubSpot has never had one', () => {
    expect(diffDealProperties({ va_open_tickets: '0' }, {})).toEqual({ va_open_tickets: '0' })
  })

  it('clears a value when Shadow has none', () => {
    expect(diffDealProperties({ va_accountant: '' }, { va_accountant: 'Old Name' })).toEqual({ va_accountant: '' })
  })

  it('a second run after pushing produces no changes (no loops)', () => {
    const desired = { va_accountant: 'Priya', va_open_tickets: '2' }
    const afterPush = { ...desired }
    expect(diffDealProperties(desired, afterPush)).toEqual({})
  })
})

describe('sameHubspotValue', () => {
  it('does not treat text that looks different as equal', () => {
    expect(sameHubspotValue('DC', 'DS')).toBe(false)
    expect(sameHubspotValue('0', '')).toBe(false)
    expect(sameHubspotValue(' DC ', 'DC')).toBe(true)
  })
})

describe('parseWonStageIds / parseAmount', () => {
  it('parses a comma list and ignores blanks', () => {
    expect([...WON]).toEqual(['closedwon', '12345'])
    expect(parseWonStageIds(undefined).size).toBe(0)
  })

  it('parses amounts', () => {
    expect(parseAmount('50000')).toBe(50000)
    expect(parseAmount('1,20,000.50')).toBe(120000.5)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount(null)).toBeNull()
    expect(parseAmount('abc')).toBeNull()
  })
})

describe('mapDealToClientPatch', () => {
  const client = { deal_stage: 'appointmentscheduled', amount_paid: null }

  it('copies the stage and ignores amount while the deal is not won', () => {
    expect(mapDealToClientPatch(deal('1', { dealstage: 'contractsent', amount: '50000' }), client, WON)).toEqual({
      deal_stage: 'contractsent',
    })
  })

  it('copies amount once the deal is won (paid)', () => {
    expect(mapDealToClientPatch(deal('1', { dealstage: 'closedwon', amount: '50000' }), client, WON)).toEqual({
      deal_stage: 'closedwon',
      amount_paid: 50000,
    })
  })

  it('returns nothing when values already match', () => {
    expect(
      mapDealToClientPatch(deal('1', { dealstage: 'closedwon', amount: '50000.00' }), { deal_stage: 'closedwon', amount_paid: 50000 }, WON),
    ).toEqual({})
  })

  it('never blanks the stage when HubSpot sends none', () => {
    expect(mapDealToClientPatch(deal('1', { dealstage: null }), client, WON)).toEqual({})
  })

  it('never writes amount when no won stages are configured', () => {
    expect(mapDealToClientPatch(deal('1', { dealstage: 'closedwon', amount: '5' }), client, new Set())).toEqual({
      deal_stage: 'closedwon',
    })
  })
})

describe('buildClientFromDeal', () => {
  it('uses the deal name and leaves the client unassigned', () => {
    expect(buildClientFromDeal(deal('99', { dealname: ' Acme Pvt Ltd ', dealstage: 'closedwon', amount: '30000' }))).toEqual({
      client_name: 'Acme Pvt Ltd',
      hubspot_deal_id: '99',
      deal_stage: 'closedwon',
      amount_paid: 30000,
    })
  })

  it('falls back to the deal id when the deal has no name', () => {
    expect(buildClientFromDeal(deal('99', { dealname: null })).client_name).toBe('HubSpot deal 99')
  })
})

describe('planDealPull', () => {
  const clients = new Map([
    ['1', { client_id: 'c1', deal_stage: 'contractsent', amount_paid: null }],
    ['2', { client_id: 'c2', deal_stage: 'closedwon', amount_paid: 1000 }],
  ])

  it('updates known clients, creates clients for won deals only, and dedupes deals', () => {
    const plan = planDealPull(
      [
        deal('1', { dealstage: 'closedwon', amount: '2000' }),
        deal('1', { dealstage: 'closedwon', amount: '2000' }),
        deal('2', { dealstage: 'closedwon', amount: '1000' }),
        deal('3', { dealname: 'New Co', dealstage: '12345', amount: '500' }),
        deal('4', { dealname: 'Lead', dealstage: 'qualifiedtobuy' }),
      ],
      clients,
      WON,
    )
    expect(plan.updates).toEqual([{ clientId: 'c1', dealId: '1', patch: { deal_stage: 'closedwon', amount_paid: 2000 } }])
    expect(plan.creates).toEqual([{ client_name: 'New Co', hubspot_deal_id: '3', deal_stage: '12345', amount_paid: 500 }])
    expect(plan.unchanged).toBe(1)
    expect(plan.ignored).toBe(1)
  })
})

describe('gateClientCreates', () => {
  it('creates nothing on the first sync (no cursor)', () => {
    expect(gateClientCreates(['a', 'b'], { firstRun: true })).toEqual({ allowed: [], held: 2, reason: 'first_run' })
  })

  it('creates nothing when more than the cap would be created', () => {
    const many = Array.from({ length: MAX_CREATES_PER_RUN + 1 }, (_, i) => i)
    expect(gateClientCreates(many, { firstRun: false })).toEqual({ allowed: [], held: MAX_CREATES_PER_RUN + 1, reason: 'over_cap' })
    expect(gateClientCreates([1, 2, 3], { firstRun: false, cap: 2 }).reason).toBe('over_cap')
  })

  it('allows a normal run up to the cap', () => {
    expect(gateClientCreates([1, 2], { firstRun: false })).toEqual({ allowed: [1, 2], held: 0, reason: null })
    expect(gateClientCreates([], { firstRun: true })).toEqual({ allowed: [], held: 0, reason: null })
  })
})
