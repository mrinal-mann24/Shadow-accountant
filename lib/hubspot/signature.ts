// HubSpot webhook signature v3 (X-HubSpot-Signature-v3).
// signature = base64(HMAC-SHA256(secret, method + uri + body + timestamp)); timestamp header in ms, max 5 minutes old.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000

// HubSpot signs the URI with these characters decoded.
const DECODE: Record<string, string> = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$', '%27': "'",
  '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
}

export function normaliseSignedUri(uri: string): string {
  return uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => DECODE[m.toUpperCase()] ?? m)
}

export function computeSignatureV3(o: { secret: string; method: string; uri: string; body: string; timestamp: string }): string {
  return createHmac('sha256', o.secret)
    .update(`${o.method.toUpperCase()}${normaliseSignedUri(o.uri)}${o.body}${o.timestamp}`, 'utf8')
    .digest('base64')
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string }

export function verifySignatureV3(o: {
  secret: string | undefined
  method: string
  uri: string
  body: string
  signature: string | null
  timestamp: string | null
  now: number
}): SignatureCheck {
  if (!o.secret) return { ok: false, reason: 'webhook secret not configured' }
  if (!o.signature || !o.timestamp) return { ok: false, reason: 'missing signature headers' }
  const ts = Number(o.timestamp)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid timestamp' }
  if (Math.abs(o.now - ts) > MAX_SIGNATURE_AGE_MS) return { ok: false, reason: 'timestamp outside 5 minutes' }
  const expected = Buffer.from(
    computeSignatureV3({ secret: o.secret, method: o.method, uri: o.uri, body: o.body, timestamp: o.timestamp }),
  )
  const given = Buffer.from(o.signature.trim())
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad signature' }
  return { ok: true }
}

const webhookEvents = z.array(
  z.looseObject({
    objectId: z.union([z.number(), z.string()]),
    subscriptionType: z.string(),
  }),
)

/** Unique deal ids from a HubSpot webhook body (deal.* subscriptions only). Null when the body is not valid. */
export function dealIdsFromWebhook(body: unknown): string[] | null {
  const parsed = webhookEvents.safeParse(body)
  if (!parsed.success) return null
  const ids = parsed.data
    .filter((e) => e.subscriptionType.startsWith('deal.'))
    .map((e) => String(e.objectId).trim())
    .filter((id) => /^\d+$/.test(id))
  return [...new Set(ids)]
}
