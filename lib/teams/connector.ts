import 'server-only'
import { teamsEnv } from './env'
import type { OutgoingActivity, TeamsConnector, TeamsMember } from './types'

// Minimal Bot Connector REST client. No SDK.
// Auth: client credentials token from Entra (single tenant bot). Retries 429 and 5xx once (Retry-After, capped at 5 s).
// Errors carry the method, status and path only: never the token, the client secret or the response body.

export type TeamsConnectorOptions = {
  appId: string
  password: string
  tenantId: string
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const TOKEN_SCOPE = 'https://api.botframework.com/.default'
const TOKEN_EARLY_MS = 5 * 60 * 1000
const MAX_RETRY_WAIT_MS = 5000
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * The serviceUrl comes from the incoming activity (or our stored channel map). We only ever send our token to
 * Microsoft's Bot Framework hosts, so a forged serviceUrl cannot collect it.
 */
export function assertAllowedServiceUrl(serviceUrl: string): URL {
  let url: URL
  try {
    url = new URL(serviceUrl)
  } catch {
    throw new Error('Teams serviceUrl is not a valid URL')
  }
  const host = url.hostname.toLowerCase()
  // Exact Teams host only: anyone can register other *.trafficmanager.net names in Azure.
  const allowed = host === 'smba.trafficmanager.net' || host.endsWith('.botframework.com')
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) {
    throw new Error('Teams serviceUrl is not an allowed Bot Framework host')
  }
  return url
}

/** serviceUrl (with or without a trailing slash, possibly with a path) + '/v3/...'. */
export function joinServiceUrl(serviceUrl: string, path: string): string {
  const base = assertAllowedServiceUrl(serviceUrl)
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function retryWaitMs(retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS)
  return 1000
}

/** Per-request timeout for Bot Connector and Entra token calls. */
export const REQUEST_TIMEOUT_MS = 15_000

export function createTeamsConnector(o: TeamsConnectorOptions): TeamsConnector {
  const doFetch = o.fetchImpl ?? fetch
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? defaultSleep
  let token: { value: string; expiresAt: number } | null = null

  // Each attempt is capped, so a slow Microsoft endpoint can never hold a job or the bot past Vercel's limit.
  const attempt = (url: string, init: RequestInit) => doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

  async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const res = await attempt(url, init)
    if (res.status !== 429 && res.status < 500) return res
    await sleep(retryWaitMs(res.headers.get('retry-after')))
    return attempt(url, init)
  }

  async function getToken(): Promise<string> {
    if (token && now() < token.expiresAt) return token.value
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: o.appId,
      client_secret: o.password,
      scope: TOKEN_SCOPE,
    })
    const path = `/${encodeURIComponent(o.tenantId)}/oauth2/v2.0/token`
    const res = await fetchWithRetry(`https://login.microsoftonline.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) throw new Error(`Teams token request failed with ${res.status}`)
    const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
    if (typeof json.access_token !== 'string' || !json.access_token) throw new Error('Teams token response has no access_token')
    const expiresIn = Number(json.expires_in)
    const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600 * 1000
    token = { value: json.access_token, expiresAt: now() + lifetimeMs - TOKEN_EARLY_MS }
    return token.value
  }

  async function call(method: 'GET' | 'POST' | 'PUT', serviceUrl: string, path: string, body?: unknown): Promise<Response> {
    // Check the host before anything else, so a bad serviceUrl never triggers a token request either.
    const url = joinServiceUrl(serviceUrl, path)
    const accessToken = await getToken()
    const res = await fetchWithRetry(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Teams ${method} ${path} failed with ${res.status}`)
    return res
  }

  const conv = (conversationId: string) => `/v3/conversations/${encodeURIComponent(conversationId)}`

  return {
    async send(serviceUrl: string, conversationId: string, activity: OutgoingActivity) {
      const res = await call('POST', serviceUrl, `${conv(conversationId)}/activities`, activity)
      const json = (await res.json().catch(() => ({}))) as { id?: unknown }
      return { id: typeof json.id === 'string' ? json.id : '' }
    },

    async update(serviceUrl: string, conversationId: string, activityId: string, activity: OutgoingActivity) {
      await call('PUT', serviceUrl, `${conv(conversationId)}/activities/${encodeURIComponent(activityId)}`, activity)
    },

    async member(serviceUrl: string, conversationId: string, userId: string): Promise<TeamsMember> {
      const res = await call('GET', serviceUrl, `${conv(conversationId)}/members/${encodeURIComponent(userId)}`)
      const json = (await res.json()) as Record<string, unknown>
      const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
      return {
        email: str(json.email) ?? str(json.userPrincipalName),
        name: str(json.name),
        aadObjectId: str(json.aadObjectId),
      }
    },
  }
}

let memo: { key: string; connector: TeamsConnector } | null = null

/** Connector built from TEAMS_BOT_* env, or null when the bot is not configured. Memoised per env values. */
export function defaultConnector(): TeamsConnector | null {
  const env = teamsEnv()
  if (!env) return null
  const key = `${env.appId}\n${env.tenantId}\n${env.password}`
  if (!memo || memo.key !== key) memo = { key, connector: createTeamsConnector(env) }
  return memo.connector
}
