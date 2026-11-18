import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTeamsConnector, defaultConnector, joinServiceUrl } from './connector'
import type { OutgoingActivity } from './types'

const SECRET = 'super-secret-password'
const SERVICE_URL = 'https://smba.trafficmanager.net/in/'
const TOKEN_URL = 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token'

type Call = { url: string; init: RequestInit }

function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response) {
  const calls: Call[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }) as unknown as typeof fetch
  return { fn, calls }
}

const tokenRes = (token = 'tok-1', expiresIn = 3600) => Response.json({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' })

const msg: OutgoingActivity = { type: 'message', text: 'hello' }

function make(handler: (url: string, init: RequestInit, n: number) => Response, now = () => 1_000_000) {
  const f = fakeFetch(handler)
  const sleep = vi.fn(async () => {})
  const c = createTeamsConnector({ appId: 'app-1', password: SECRET, tenantId: 'tenant-1', fetchImpl: f.fn, now, sleep })
  return { c, calls: f.calls, sleep }
}

afterEach(() => vi.unstubAllEnvs())

describe('joinServiceUrl', () => {
  it('joins with or without a trailing slash', () => {
    expect(joinServiceUrl('https://smba.trafficmanager.net/in/', '/v3/x')).toBe('https://smba.trafficmanager.net/in/v3/x')
    expect(joinServiceUrl('https://smba.trafficmanager.net/in', 'v3/x')).toBe('https://smba.trafficmanager.net/in/v3/x')
    expect(joinServiceUrl('https://smba.trafficmanager.net/', '/v3/x')).toBe('https://smba.trafficmanager.net/v3/x')
  })

  it('rejects hosts outside the Bot Framework', () => {
    expect(() => joinServiceUrl('http://smba.trafficmanager.net/in/', '/v3')).toThrow()
    expect(() => joinServiceUrl('https://evil.example.com/', '/v3')).toThrow()
    expect(() => joinServiceUrl('https://trafficmanager.net.evil.com/', '/v3')).toThrow()
    // Anyone can register other *.trafficmanager.net names: only the Teams host is allowed.
    expect(() => joinServiceUrl('https://attacker.trafficmanager.net/', '/v3')).toThrow()
    expect(joinServiceUrl('https://smba.botframework.com/', '/v3')).toBe('https://smba.botframework.com/v3')
    expect(() => joinServiceUrl('https://user:pw@smba.trafficmanager.net/', '/v3')).toThrow()
    expect(() => joinServiceUrl('not a url', '/v3')).toThrow()
    expect(joinServiceUrl('https://europe.webchat.botframework.com/', '/v3')).toBe('https://europe.webchat.botframework.com/v3')
  })
})

describe('createTeamsConnector', () => {
  it('fetches one token for two sends and posts to the encoded conversation', async () => {
    const { c, calls } = make((url) => (url === TOKEN_URL ? tokenRes() : Response.json({ id: 'act-1' })))
    const convId = '19:abc@thread.tacv2;messageid=123'
    await expect(c.send(SERVICE_URL, convId, msg)).resolves.toEqual({ id: 'act-1' })
    await c.send(SERVICE_URL, convId, msg)

    expect(calls.filter((x) => x.url === TOKEN_URL)).toHaveLength(1)
    const tokenBody = new URLSearchParams(String(calls[0].init.body))
    expect(tokenBody.get('grant_type')).toBe('client_credentials')
    expect(tokenBody.get('client_id')).toBe('app-1')
    expect(tokenBody.get('client_secret')).toBe(SECRET)
    expect(tokenBody.get('scope')).toBe('https://api.botframework.com/.default')

    const send = calls[1]
    expect(send.url).toBe('https://smba.trafficmanager.net/in/v3/conversations/19%3Aabc%40thread.tacv2%3Bmessageid%3D123/activities')
    expect(send.init.method).toBe('POST')
    expect((send.init.headers as Record<string, string>).authorization).toBe('Bearer tok-1')
    expect(JSON.parse(String(send.init.body))).toEqual(msg)
  })

  it('refreshes the token 5 minutes before it expires', async () => {
    let t = 0
    let n = 0
    const { c, calls } = make(
      (url) => (url === TOKEN_URL ? tokenRes(`tok-${++n}`, 3600) : Response.json({ id: 'a' })),
      () => t,
    )
    await c.send(SERVICE_URL, 'c', msg)
    t = (3600 - 301) * 1000
    await c.send(SERVICE_URL, 'c', msg)
    expect(calls.filter((x) => x.url === TOKEN_URL)).toHaveLength(1)
    t = (3600 - 299) * 1000
    await c.send(SERVICE_URL, 'c', msg)
    expect(calls.filter((x) => x.url === TOKEN_URL)).toHaveLength(2)
    expect((calls.at(-1)!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-2')
  })

  it('updates with PUT to the encoded activity id', async () => {
    const { c, calls } = make((url) => (url === TOKEN_URL ? tokenRes() : Response.json({})))
    await c.update(SERVICE_URL, 'a:b', '1;2', msg)
    expect(calls[1].url).toBe('https://smba.trafficmanager.net/in/v3/conversations/a%3Ab/activities/1%3B2')
    expect(calls[1].init.method).toBe('PUT')
  })

  it('maps a member, falling back to userPrincipalName', async () => {
    const { c, calls } = make((url) =>
      url === TOKEN_URL ? tokenRes() : Response.json({ id: '29:x', name: 'Asha', userPrincipalName: 'asha@x.in', aadObjectId: 'aad-1' }),
    )
    await expect(c.member(SERVICE_URL, 'a:b', '29:x')).resolves.toEqual({ email: 'asha@x.in', name: 'Asha', aadObjectId: 'aad-1' })
    expect(calls[1].url).toBe('https://smba.trafficmanager.net/in/v3/conversations/a%3Ab/members/29%3Ax')
    expect(calls[1].init.method).toBe('GET')
  })

  it('prefers email and returns nulls for missing fields', async () => {
    const { c } = make((url) => (url === TOKEN_URL ? tokenRes() : Response.json({ email: 'e@x.in', userPrincipalName: 'u@x.in' })))
    await expect(c.member(SERVICE_URL, 'c', 'u')).resolves.toEqual({ email: 'e@x.in', name: null, aadObjectId: null })
  })

  it('throws for a disallowed serviceUrl without calling fetch', async () => {
    const { c, calls } = make(() => Response.json({}))
    await expect(c.send('https://attacker.example.com/', 'c', msg)).rejects.toThrow(/serviceUrl/)
    await expect(c.member('http://smba.trafficmanager.net/', 'c', 'u')).rejects.toThrow(/serviceUrl/)
    expect(calls).toHaveLength(0)
  })

  it('retries once on 429, honouring Retry-After capped at 5 s', async () => {
    let sends = 0
    const { c, calls, sleep } = make((url) => {
      if (url === TOKEN_URL) return tokenRes()
      sends++
      return sends === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }) : Response.json({ id: 'ok' })
    })
    await expect(c.send(SERVICE_URL, 'c', msg)).resolves.toEqual({ id: 'ok' })
    expect(sends).toBe(2)
    expect(sleep).toHaveBeenCalledWith(5000)
    expect(calls).toHaveLength(3)
  })

  it('gives up after one retry and the error has status and path only', async () => {
    const { c } = make((url) =>
      url === TOKEN_URL ? tokenRes('tok-secret') : new Response(`boom ${SECRET} tok-secret`, { status: 503 }),
    )
    const err = (await c.send(SERVICE_URL, 'c', msg).then(
      () => null,
      (e: unknown) => e,
    )) as Error
    expect(err.message).toContain('503')
    expect(err.message).toContain('/v3/conversations/c/activities')
    expect(err.message).not.toContain(SECRET)
    expect(err.message).not.toContain('tok-secret')
  })

  it('token failure error does not contain the client secret', async () => {
    const { c } = make(() => new Response(`invalid_client ${SECRET}`, { status: 401 }))
    const err = (await c.send(SERVICE_URL, 'c', msg).then(
      () => null,
      (e: unknown) => e,
    )) as Error
    expect(err.message).toContain('401')
    expect(err.message).not.toContain(SECRET)
  })
})

describe('defaultConnector', () => {
  it('is null without env and memoised with env', () => {
    vi.stubEnv('TEAMS_BOT_APP_ID', '')
    expect(defaultConnector()).toBeNull()
    vi.stubEnv('TEAMS_BOT_APP_ID', 'app')
    vi.stubEnv('TEAMS_BOT_APP_PASSWORD', 'pw')
    vi.stubEnv('TEAMS_BOT_TENANT_ID', 't')
    const a = defaultConnector()
    expect(a).not.toBeNull()
    expect(defaultConnector()).toBe(a)
  })
})
