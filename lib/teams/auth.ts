import 'server-only'
import { createPublicKey, verify, type JsonWebKey } from 'node:crypto'
import { BotAuthError } from './types'

// Verifies the JWT that the Bot Framework puts on every request to our messaging endpoint.
// https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
// No SDK: OpenID metadata -> JWKS -> RS256 signature check -> claims. Never logs the token.

const OPENID_METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
const ISSUER = 'https://api.botframework.com'
const KEY_TTL_MS = 24 * 60 * 60 * 1000
const CLOCK_SKEW_S = 5 * 60

type BotJwk = JsonWebKey & { kid?: string; endorsements?: string[] }

let keyCache: { keys: BotJwk[]; fetchedAt: number } | null = null
/** An unknown kid refetches the keys at most once a minute. */
const KEY_REFETCH_FLOOR_MS = 60_000

/** Clears the in-memory signing key cache. For tests. */
export function resetBotKeyCache(): void {
  keyCache = null
}

function fail(reason: string): never {
  throw new BotAuthError(`Bot Framework token rejected: ${reason}`)
}

function decodeJson(part: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // fall through
  }
  return fail(`${what} is not valid`)
}

async function fetchKeys(fetchImpl: typeof fetch): Promise<BotJwk[]> {
  const metaRes = await fetchImpl(OPENID_METADATA_URL)
  if (!metaRes.ok) fail(`OpenID metadata request failed with ${metaRes.status}`)
  const meta = (await metaRes.json()) as { jwks_uri?: unknown }
  if (typeof meta.jwks_uri !== 'string' || !meta.jwks_uri.startsWith('https://')) fail('OpenID metadata has no jwks_uri')
  const jwksRes = await fetchImpl(meta.jwks_uri)
  if (!jwksRes.ok) fail(`signing keys request failed with ${jwksRes.status}`)
  const jwks = (await jwksRes.json()) as { keys?: unknown }
  if (!Array.isArray(jwks.keys)) fail('signing keys response has no keys')
  return jwks.keys as BotJwk[]
}

async function findKey(kid: string, nowMs: number, fetchImpl: typeof fetch): Promise<BotJwk> {
  const fresh = keyCache && nowMs - keyCache.fetchedAt < KEY_TTL_MS
  if (fresh) {
    const hit = keyCache!.keys.find((k) => k.kid === kid)
    if (hit) return hit
  }
  // Cache is stale, empty, or does not know this kid (keys rotate): refetch once. A fresh cache that was
  // fetched under a minute ago is trusted, so forged kids cannot make us call Bot Framework on every request.
  if (fresh && nowMs - keyCache!.fetchedAt < KEY_REFETCH_FLOOR_MS) fail('unknown signing key')
  const keys = await fetchKeys(fetchImpl)
  keyCache = { keys, fetchedAt: nowMs }
  const key = keys.find((k) => k.kid === kid)
  if (!key) fail('unknown signing key')
  return key
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

export async function verifyBotRequest(
  authHeader: string | null,
  activity: { serviceUrl: string },
  o: { appId: string; now?: Date; fetchImpl?: typeof fetch },
): Promise<void> {
  const fetchImpl = o.fetchImpl ?? fetch
  const nowMs = (o.now ?? new Date()).getTime()

  const match = /^Bearer\s+(\S+)$/i.exec(authHeader?.trim() ?? '')
  if (!match) fail('missing Bearer token')
  const parts = match[1].split('.')
  if (parts.length !== 3 || parts.some((p) => !p)) fail('token is not a JWT')
  const [headerPart, payloadPart, signaturePart] = parts

  const header = decodeJson(headerPart, 'header')
  const payload = decodeJson(payloadPart, 'payload')
  if (header.alg !== 'RS256') fail('algorithm must be RS256')
  if (typeof header.kid !== 'string' || !header.kid) fail('header has no kid')

  const jwk = await findKey(header.kid, nowMs, fetchImpl)
  // Bot Framework keys always list the channels they sign for; a key without 'msteams' is not for us.
  if (!Array.isArray(jwk.endorsements) || !jwk.endorsements.includes('msteams')) fail('signing key is not endorsed for msteams')

  let ok = false
  try {
    // Only the public parts of the JWK go to createPublicKey (drop kid, endorsements and other extras).
    const publicKey = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' })
    ok = verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      Buffer.from(signaturePart, 'base64url'),
    )
  } catch {
    ok = false
  }
  if (!ok) fail('signature is not valid')

  if (payload.iss !== ISSUER) fail('issuer is not the Bot Framework')
  const aud = payload.aud
  if (Array.isArray(aud) ? !aud.includes(o.appId) : aud !== o.appId) fail('audience is not this bot')

  const nowS = nowMs / 1000
  if (typeof payload.exp !== 'number') fail('token has no expiry')
  if (nowS > payload.exp + CLOCK_SKEW_S) fail('token has expired')
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number') fail('nbf is not valid')
    if (nowS < payload.nbf - CLOCK_SKEW_S) fail('token is not valid yet')
  }

  // Channel tokens always carry the serviceUrl they were issued for. Required, so a valid token cannot be
  // replayed with a different serviceUrl in the body.
  const claimUrl = payload.serviceurl ?? payload.serviceUrl
  if (typeof claimUrl !== 'string' || trimSlash(claimUrl) !== trimSlash(activity.serviceUrl ?? '')) {
    fail('serviceUrl does not match the token')
  }
}
