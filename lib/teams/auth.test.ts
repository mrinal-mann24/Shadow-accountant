import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetBotKeyCache, verifyBotRequest } from './auth'
import { BotAuthError } from './types'

const APP_ID = 'app-123'
const SERVICE_URL = 'https://smba.trafficmanager.net/in/'
const JWKS_URI = 'https://login.botframework.com/v1/.well-known/keys'
const NOW = new Date('2026-11-18T10:00:00Z')
const nowS = Math.floor(NOW.getTime() / 1000)

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })

// null = no endorsements property at all (undefined would fall back to the default).
const jwk = (key: KeyObject, kid: string, endorsements: string[] | null = ['msteams']) => ({
  ...key.export({ format: 'jwk' }),
  kid,
  use: 'sig',
  ...(endorsements ? { endorsements } : {}),
})

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

function makeToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: KeyObject = privateKey,
): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...header })
  const p = b64({
    iss: 'https://api.botframework.com',
    aud: APP_ID,
    exp: nowS + 3600,
    nbf: nowS - 60,
    serviceurl: SERVICE_URL,
    ...claims,
  })
  const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')
  return `${h}.${p}.${s}`
}

function fakeFetch(keySets: unknown[][]) {
  const calls: string[] = []
  let jwksServed = 0
  const fn = (async (url: string) => {
    calls.push(url)
    if (url.includes('openidconfiguration')) return Response.json({ jwks_uri: JWKS_URI })
    if (url === JWKS_URI) {
      const keys = keySets[Math.min(jwksServed, keySets.length - 1)]
      jwksServed++
      return Response.json({ keys })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return { fn, calls, jwksCalls: () => calls.filter((c) => c === JWKS_URI).length }
}

const run = (token: string | null, fetchImpl: typeof fetch, serviceUrl = SERVICE_URL) =>
  verifyBotRequest(token === null ? null : `Bearer ${token}`, { serviceUrl }, { appId: APP_ID, now: NOW, fetchImpl })

beforeEach(() => resetBotKeyCache())

describe('verifyBotRequest', () => {
  it('accepts a valid token, and the serviceUrl match ignores a trailing slash', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken(), f.fn, 'https://smba.trafficmanager.net/in')).resolves.toBeUndefined()
  })

  it('accepts the serviceUrl claim spelt serviceUrl', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken({ serviceurl: undefined, serviceUrl: SERVICE_URL }), f.fn)).resolves.toBeUndefined()
  })

  it('caches keys between requests', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await run(makeToken(), f.fn)
    await run(makeToken(), f.fn)
    expect(f.jwksCalls()).toBe(1)
  })

  it('rejects a missing or garbage header', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(verifyBotRequest(null, { serviceUrl: SERVICE_URL }, { appId: APP_ID, now: NOW, fetchImpl: f.fn })).rejects.toBeInstanceOf(
      BotAuthError,
    )
    await expect(verifyBotRequest('Basic abc', { serviceUrl: SERVICE_URL }, { appId: APP_ID, now: NOW, fetchImpl: f.fn })).rejects.toBeInstanceOf(
      BotAuthError,
    )
    await expect(run('not.a-jwt', f.fn)).rejects.toBeInstanceOf(BotAuthError)
    await expect(run('%%%.###.$$$', f.fn)).rejects.toBeInstanceOf(BotAuthError)
  })

  it('rejects a token signed by another key', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken({}, {}, other.privateKey), f.fn)).rejects.toThrow(/signature/)
  })

  it('rejects a tampered payload', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    const [h, , s] = makeToken().split('.')
    const forged = b64({ iss: 'https://api.botframework.com', aud: APP_ID, exp: nowS + 3600 })
    await expect(run(`${h}.${forged}.${s}`, f.fn)).rejects.toThrow(/signature/)
  })

  it('rejects the wrong audience', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken({ aud: 'someone-else' }), f.fn)).rejects.toThrow(/audience/)
  })

  it('rejects the wrong issuer', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken({ iss: 'https://sts.windows.net/x/' }), f.fn)).rejects.toThrow(/issuer/)
  })

  it('allows 5 minutes of skew on exp but rejects beyond it', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken({ exp: nowS - 240 }), f.fn)).resolves.toBeUndefined()
    await expect(run(makeToken({ exp: nowS - 301 }), f.fn)).rejects.toThrow(/expired/)
  })

  it('rejects nbf in the future beyond skew', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken({ nbf: nowS + 240 }), f.fn)).resolves.toBeUndefined()
    await expect(run(makeToken({ nbf: nowS + 301 }), f.fn)).rejects.toThrow(/not valid yet/)
  })

  it('rejects a serviceUrl that does not match the token', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken(), f.fn, 'https://evil.example.com/')).rejects.toThrow(/serviceUrl/)
  })

  it('refetches keys once for an unknown kid, at most once a minute', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')], [jwk(publicKey, 'k1'), jwk(other.publicKey, 'k2')]])
    const at = (ms: number, token: string) =>
      verifyBotRequest(`Bearer ${token}`, { serviceUrl: SERVICE_URL }, { appId: APP_ID, now: new Date(NOW.getTime() + ms), fetchImpl: f.fn })
    await at(0, makeToken())
    expect(f.jwksCalls()).toBe(1)
    // Forged kid within the minute: rejected without calling Bot Framework again.
    await expect(at(10_000, makeToken({}, { kid: 'k9' }))).rejects.toThrow(/unknown signing key/)
    expect(f.jwksCalls()).toBe(1)
    // Key rotation after the minute: refetched once and accepted.
    await expect(at(61_000, makeToken({}, { kid: 'k2' }, other.privateKey))).resolves.toBeUndefined()
    expect(f.jwksCalls()).toBe(2)
  })

  it('rejects a key whose endorsements do not include msteams', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1', ['skype'])]])
    await expect(run(makeToken(), f.fn)).rejects.toThrow(/msteams/)
  })

  it('rejects a key with no endorsements list', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1', null)]])
    await expect(run(makeToken(), f.fn)).rejects.toThrow(/msteams/)
  })

  it('rejects a token without a serviceUrl claim', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken({ serviceurl: undefined }), f.fn)).rejects.toThrow(/serviceUrl/)
  })

  it('rejects HS256 and none', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    await expect(run(makeToken({}, { alg: 'HS256' }), f.fn)).rejects.toThrow(/RS256/)
    await expect(run(makeToken({}, { alg: 'none' }), f.fn)).rejects.toThrow(/RS256/)
    expect(f.calls).toHaveLength(0)
  })

  it('never puts the token in the error message', async () => {
    const f = fakeFetch([[jwk(publicKey, 'k1')]])
    const token = makeToken({ aud: 'x' })
    const err = (await run(token, f.fn).then(
      () => null,
      (e: unknown) => e,
    )) as Error
    expect(err).toBeInstanceOf(BotAuthError)
    expect(err.message).not.toContain(token.split('.')[2])
  })
})
