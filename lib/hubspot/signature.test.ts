import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeSignatureV3, dealIdsFromWebhook, normaliseSignedUri, verifySignatureV3 } from './signature'

const secret = 'test-secret'
const uri = 'https://shadow.example.com/api/webhooks/hubspot'
const body = '[{"objectId":123,"subscriptionType":"deal.propertyChange","propertyName":"dealstage"}]'
const now = 1_760_000_000_000
const timestamp = String(now - 60_000)

function sign(o: { method?: string; uri?: string; body?: string; timestamp?: string } = {}) {
  return createHmac('sha256', secret)
    .update(`${o.method ?? 'POST'}${o.uri ?? uri}${o.body ?? body}${o.timestamp ?? timestamp}`)
    .digest('base64')
}

const base = { secret, method: 'POST', uri, body, timestamp, now }

describe('verifySignatureV3', () => {
  it('accepts a valid signature', () => {
    expect(verifySignatureV3({ ...base, signature: sign() })).toEqual({ ok: true })
    expect(computeSignatureV3({ secret, method: 'post', uri, body, timestamp })).toBe(sign())
  })

  it('rejects a tampered body', () => {
    expect(verifySignatureV3({ ...base, body: body.replace('123', '124'), signature: sign() }).ok).toBe(false)
  })

  it('rejects the wrong secret', () => {
    expect(verifySignatureV3({ ...base, secret: 'other', signature: sign() }).ok).toBe(false)
  })

  it('rejects a timestamp older than 5 minutes, and one too far in the future', () => {
    const old = String(now - 5 * 60_000 - 1)
    expect(verifySignatureV3({ ...base, timestamp: old, signature: sign({ timestamp: old }) })).toEqual({
      ok: false,
      reason: 'timestamp outside 5 minutes',
    })
    const future = String(now + 6 * 60_000)
    expect(verifySignatureV3({ ...base, timestamp: future, signature: sign({ timestamp: future }) }).ok).toBe(false)
  })

  it('fails closed with no secret or missing headers', () => {
    expect(verifySignatureV3({ ...base, secret: undefined, signature: sign() }).ok).toBe(false)
    expect(verifySignatureV3({ ...base, signature: null }).ok).toBe(false)
    expect(verifySignatureV3({ ...base, timestamp: null, signature: sign() }).ok).toBe(false)
    expect(verifySignatureV3({ ...base, timestamp: 'abc', signature: sign() }).ok).toBe(false)
  })

  it('signs the URI with HubSpot decoded characters', () => {
    const encoded = 'https://shadow.example.com/api/webhooks/hubspot?x=a%3Ab%2Cc'
    const decoded = 'https://shadow.example.com/api/webhooks/hubspot?x=a:b,c'
    expect(normaliseSignedUri(encoded)).toBe(decoded)
    expect(verifySignatureV3({ ...base, uri: encoded, signature: sign({ uri: decoded }) })).toEqual({ ok: true })
  })
})

describe('dealIdsFromWebhook', () => {
  it('returns unique deal ids from deal events only', () => {
    expect(
      dealIdsFromWebhook([
        { objectId: 123, subscriptionType: 'deal.propertyChange', propertyName: 'dealstage' },
        { objectId: '123', subscriptionType: 'deal.propertyChange', propertyName: 'amount' },
        { objectId: 456, subscriptionType: 'deal.creation' },
        { objectId: 789, subscriptionType: 'contact.creation' },
      ]),
    ).toEqual(['123', '456'])
  })

  it('returns null for an unexpected payload and drops non numeric ids', () => {
    expect(dealIdsFromWebhook({ objectId: 1 })).toBeNull()
    expect(dealIdsFromWebhook([{ subscriptionType: 'deal.creation' }])).toBeNull()
    expect(dealIdsFromWebhook([{ objectId: '1 OR 1=1', subscriptionType: 'deal.creation' }])).toEqual([])
  })
})
