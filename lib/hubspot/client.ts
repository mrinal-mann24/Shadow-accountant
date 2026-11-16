// Minimal HubSpot CRM v3 client for Deals. No SDK.
// Auth: private app token (HUBSPOT_ACCESS_TOKEN). Retries 429 and 5xx with backoff (Retry-After when given).

export type HubspotDeal = {
  id: string
  properties: Record<string, string | null | undefined>
  updatedAt?: string
}

export class HubspotError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HubspotError'
  }
}

export type HubspotClientOptions = {
  token: string
  baseUrl?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
}

const BATCH_SIZE = 100
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** One CRM search filter. HAS_PROPERTY / NOT_HAS_PROPERTY take no value. */
export type SearchFilter = { propertyName: string; operator: string; value?: string; values?: string[] }

/** One entry of a HubSpot batch response's `errors` array (207 Multi-Status). */
export type BatchError = { message?: string; category?: string; context?: Record<string, unknown> }

/** "deals 12, 34: Property values were not valid (VALIDATION_ERROR)", cut to 300 characters. */
export function batchErrorText(e: BatchError): string {
  const ids = e.context?.ids ?? e.context?.id
  const which = Array.isArray(ids) ? `deals ${ids.join(', ')}: ` : typeof ids === 'string' ? `deal ${ids}: ` : ''
  const text = `${which}${e.message ?? 'unknown error'}${e.category ? ` (${e.category})` : ''}`
  return text.slice(0, 300)
}

/** Backoff for attempt n (0-based): Retry-After seconds when present, else 1s, 2s, 4s ... capped at 30s. */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000)
  return Math.min(1000 * 2 ** attempt, 30_000)
}

export function createHubspotClient(opts: HubspotClientOptions) {
  const baseUrl = opts.baseUrl ?? 'https://api.hubapi.com'
  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const maxRetries = opts.maxRetries ?? 4

  async function request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.token}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(retryDelayMs(attempt, res.headers.get('retry-after')))
        continue
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new HubspotError(`HubSpot ${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`, res.status)
      }
      // batch endpoints can return 207 (partial success) with the same shape
      return (await res.json()) as T
    }
  }

  /** Every deal matching all `filters` (one AND group; none = all deals), oldest modified first, paged. */
  async function searchDeals(filters: SearchFilter[], properties: string[]): Promise<HubspotDeal[]> {
    const deals: HubspotDeal[] = []
    let after: string | undefined
    do {
      const page = await request<{ results: HubspotDeal[]; paging?: { next?: { after?: string } } }>(
        'POST',
        '/crm/v3/objects/deals/search',
        {
          filterGroups: filters.length ? [{ filters }] : [],
          sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
          properties,
          limit: 100,
          ...(after ? { after } : {}),
        },
      )
      deals.push(...page.results)
      after = page.paging?.next?.after
    } while (after)
    return deals
  }

  /** Deals with hs_lastmodifieddate >= since (all deals when since is null), oldest first. */
  async function searchDealsModifiedSince(since: Date | null, properties: string[]): Promise<HubspotDeal[]> {
    return searchDeals(
      since ? [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(since.getTime()) }] : [],
      properties,
    )
  }

  /** Stage id -> label for one deal pipeline. */
  async function getPipelineStageLabels(pipelineId: string): Promise<Map<string, string>> {
    const res = await request<{ stages?: { id: string; label: string }[] }>(
      'GET',
      `/crm/v3/pipelines/deals/${encodeURIComponent(pipelineId)}`,
    )
    return new Map((res.stages ?? []).map((s) => [String(s.id), s.label]))
  }

  /** Owner id -> lowercase email, for every active owner. */
  async function listOwnerEmails(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    let after: string | undefined
    do {
      const qs = new URLSearchParams({ limit: '500', ...(after ? { after } : {}) })
      const page = await request<{ results: { id: string; email?: string | null }[]; paging?: { next?: { after?: string } } }>(
        'GET',
        `/crm/v3/owners?${qs.toString()}`,
      )
      for (const o of page.results) if (o.email) out.set(String(o.id), o.email.trim().toLowerCase())
      after = page.paging?.next?.after
    } while (after)
    return out
  }

  /** Batch read by deal id. Deals that do not exist are simply missing from the result. */
  async function batchReadDeals(ids: string[], properties: string[]): Promise<HubspotDeal[]> {
    const out: HubspotDeal[] = []
    for (const part of chunk([...new Set(ids)], BATCH_SIZE)) {
      const res = await request<{ results: HubspotDeal[] }>('POST', '/crm/v3/objects/deals/batch/read', {
        properties,
        inputs: part.map((id) => ({ id })),
      })
      out.push(...res.results)
    }
    return out
  }

  /**
   * Batch update deal properties. Returns how many deals HubSpot reported as updated, plus one message per
   * failed input: a 207 Multi-Status response carries an `errors` array (for example a va_* property that
   * does not exist yet, or an invalid number) next to the deals that did update.
   */
  async function batchUpdateDeals(
    updates: { id: string; properties: Record<string, string> }[],
  ): Promise<{ updated: number; errors: string[] }> {
    let updated = 0
    const errors: string[] = []
    for (const part of chunk(updates, BATCH_SIZE)) {
      const res = await request<{ results?: HubspotDeal[]; errors?: BatchError[] }>(
        'POST',
        '/crm/v3/objects/deals/batch/update',
        { inputs: part },
      )
      updated += res.results?.length ?? 0
      for (const e of res.errors ?? []) errors.push(batchErrorText(e))
    }
    return { updated, errors }
  }

  return {
    request,
    searchDeals,
    searchDealsModifiedSince,
    getPipelineStageLabels,
    listOwnerEmails,
    batchReadDeals,
    batchUpdateDeals,
  }
}

export type HubspotClient = ReturnType<typeof createHubspotClient>
