import { describe, expect, it } from 'vitest'
import { createHubspotClient, HubspotError, retryDelayMs } from './client'

function fakeFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('no more responses')
    return next
  }) as unknown as typeof fetch
  return { fn, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('retryDelayMs', () => {
  it('honours Retry-After and otherwise backs off exponentially with a cap', () => {
    expect(retryDelayMs(0, '2')).toBe(2000)
    expect(retryDelayMs(0, null)).toBe(1000)
    expect(retryDelayMs(2, null)).toBe(4000)
    expect(retryDelayMs(10, null)).toBe(30_000)
  })
})

describe('createHubspotClient', () => {
  it('retries on 429 then succeeds', async () => {
    const sleeps: number[] = []
    const { fn, calls } = fakeFetch([json({}, 429, { 'retry-after': '1' }), json({ results: [{ id: '1', properties: {} }] })])
    const hs = createHubspotClient({ token: 't', fetch: fn, sleep: async (ms) => void sleeps.push(ms) })
    const deals = await hs.batchReadDeals(['1'], ['dealstage'])
    expect(deals).toEqual([{ id: '1', properties: {} }])
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([1000])
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer t')
  })

  it('gives up after maxRetries with a HubspotError', async () => {
    const { fn } = fakeFetch([json({}, 429), json({}, 429)])
    const hs = createHubspotClient({ token: 't', fetch: fn, sleep: async () => {}, maxRetries: 1 })
    await expect(hs.batchReadDeals(['1'], [])).rejects.toBeInstanceOf(HubspotError)
  })

  it('does not retry a 400', async () => {
    const { fn, calls } = fakeFetch([json({ message: 'bad' }, 400)])
    const hs = createHubspotClient({ token: 't', fetch: fn, sleep: async () => {} })
    await expect(hs.batchUpdateDeals([{ id: '1', properties: { va_open_tickets: '1' } }])).rejects.toThrow(/400/)
    expect(calls).toHaveLength(1)
  })

  it('pages through search results and sends the modified-since filter', async () => {
    const { fn, calls } = fakeFetch([
      json({ results: [{ id: '1', properties: {} }], paging: { next: { after: '1' } } }),
      json({ results: [{ id: '2', properties: {} }] }),
    ])
    const hs = createHubspotClient({ token: 't', fetch: fn })
    const since = new Date('2026-11-01T00:00:00Z')
    const deals = await hs.searchDealsModifiedSince(since, ['dealstage'])
    expect(deals.map((d) => d.id)).toEqual(['1', '2'])
    const first = JSON.parse(calls[0].init.body as string)
    expect(first.filterGroups[0].filters[0]).toEqual({
      propertyName: 'hs_lastmodifieddate',
      operator: 'GTE',
      value: String(since.getTime()),
    })
    expect(JSON.parse(calls[1].init.body as string).after).toBe('1')
  })

  it('splits batch updates into chunks of 100', async () => {
    const updates = Array.from({ length: 150 }, (_, i) => ({ id: String(i), properties: { va_open_tickets: '0' } }))
    const { fn, calls } = fakeFetch([
      json({ results: updates.slice(0, 100) }),
      json({ results: updates.slice(100) }),
    ])
    const hs = createHubspotClient({ token: 't', fetch: fn })
    expect(await hs.batchUpdateDeals(updates)).toEqual({ updated: 150, errors: [] })
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe('https://api.hubapi.com/crm/v3/objects/deals/batch/update')
  })

  it('reports per-deal errors from a 207 Multi-Status batch update', async () => {
    const { fn } = fakeFetch([
      json(
        {
          status: 'COMPLETE',
          results: [{ id: '1', properties: {} }],
          numErrors: 1,
          errors: [{ status: 'error', category: 'VALIDATION_ERROR', message: 'Property "va_bucket" does not exist', context: { ids: ['2'] } }],
        },
        207,
      ),
    ])
    const hs = createHubspotClient({ token: 't', fetch: fn })
    const res = await hs.batchUpdateDeals([
      { id: '1', properties: { va_open_tickets: '1' } },
      { id: '2', properties: { va_bucket: 'DC' } },
    ])
    expect(res).toEqual({ updated: 1, errors: ['deals 2: Property "va_bucket" does not exist (VALIDATION_ERROR)'] })
  })
})
