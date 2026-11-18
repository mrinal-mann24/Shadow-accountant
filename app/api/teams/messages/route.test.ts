import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotAuthError } from '@/lib/teams/types'

const verify = vi.fn()
const handle = vi.fn()
const env = vi.fn()

vi.mock('next/server', () => ({ after: (task: () => unknown) => void task() }))
vi.mock('@/lib/teams/auth', () => ({ verifyBotRequest: (...a: unknown[]) => verify(...a) }))
vi.mock('@/lib/teams/bot', () => ({ handleActivity: (...a: unknown[]) => handle(...a) }))
vi.mock('@/lib/teams/env', () => ({ teamsEnv: () => env(), siteUrl: () => 'https://shadow.example' }))
vi.mock('@/lib/teams/connector', () => ({ defaultConnector: () => ({ send: vi.fn(), update: vi.fn(), member: vi.fn() }) }))
vi.mock('@/lib/teams/store', () => ({ supabaseTeamsStore: () => ({}) }))
const appUserByEmail = vi.fn()
vi.mock('@/lib/teams/identity', () => ({ appUserByEmail: (...a: unknown[]) => appUserByEmail(...a) }))
vi.mock('@/lib/agent/ask', () => ({ askShadow: vi.fn() }))
const followUpAction = vi.fn()
vi.mock('@/lib/data', () => ({
  updateConversation: vi.fn(),
  ticketForUser: vi.fn(),
  reassignTicket: vi.fn(),
  followUpAction: (...a: unknown[]) => followUpAction(...a),
}))

import { POST } from './route'

const activity = { type: 'message', serviceUrl: 'https://smba.trafficmanager.net/in/', channelId: 'msteams', from: { id: '1' }, conversation: { id: 'c' } }
const req = (body: string, auth = 'Bearer token') =>
  new Request('http://localhost/api/teams/messages', { method: 'POST', headers: { authorization: auth }, body })

afterEach(() => {
  verify.mockReset()
  handle.mockReset()
  env.mockReset()
})

describe('POST /api/teams/messages', () => {
  it('503 when the bot is not configured', async () => {
    env.mockReturnValue(null)
    const res = await POST(req(JSON.stringify(activity)))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Teams bot is not configured' })
    expect(handle).not.toHaveBeenCalled()
  })

  it('400 on invalid JSON', async () => {
    env.mockReturnValue({ appId: 'app', password: 'p', tenantId: 't' })
    const res = await POST(req('{not json'))
    expect(res.status).toBe(400)
    expect(verify).not.toHaveBeenCalled()
  })

  it('401 without detail when the JWT check fails', async () => {
    env.mockReturnValue({ appId: 'app', password: 'p', tenantId: 't' })
    verify.mockRejectedValue(new BotAuthError('bad audience: app-x'))
    const res = await POST(req(JSON.stringify(activity), 'Bearer bad'))
    expect(res.status).toBe(401)
    expect(JSON.stringify(await res.json())).not.toContain('audience')
    expect(verify).toHaveBeenCalledWith('Bearer bad', expect.objectContaining({ serviceUrl: activity.serviceUrl }), { appId: 'app' })
    expect(handle).not.toHaveBeenCalled()
  })

  it('passes the bot reply through, with the tenant and a defer that runs after the response', async () => {
    env.mockReturnValue({ appId: 'app', password: 'p', tenantId: 'tenant-1' })
    verify.mockResolvedValue(undefined)
    const task = vi.fn(async () => {})
    handle.mockImplementation(async (_a: unknown, deps: { tenantId: string; siteUrl: string; defer: (t: () => Promise<void>) => void }) => {
      expect(deps.tenantId).toBe('tenant-1')
      expect(deps.siteUrl).toBe('https://shadow.example')
      deps.defer(task)
      return { status: 200, body: { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: 'ok' } }
    })
    const res = await POST(req(JSON.stringify(activity)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: 'ok' })
    expect(task).toHaveBeenCalled()
  })

  it('a reply without a body returns {} with its status; a deferred failure is caught', async () => {
    env.mockReturnValue({ appId: 'app', password: 'p', tenantId: 't' })
    verify.mockResolvedValue(undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    handle.mockImplementation(async (_a: unknown, deps: { defer: (t: () => Promise<void>) => void }) => {
      deps.defer(async () => {
        throw new Error('late failure')
      })
      return { status: 403 }
    })
    const res = await POST(req(JSON.stringify(activity)))
    await new Promise((r) => setTimeout(r, 0))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({})
    expect(err).toHaveBeenCalledWith('[teams] deferred task failed:', 'late failure')
    err.mockRestore()
  })

  it('resolves Teams users through the cached identity lookup', async () => {
    env.mockReturnValue({ appId: 'app', password: 'p', tenantId: 't' })
    verify.mockResolvedValue(undefined)
    appUserByEmail.mockResolvedValue(null)
    handle.mockImplementation(async (_a: unknown, deps: { resolveUser: (email: string) => Promise<unknown> }) => {
      expect(await deps.resolveUser('asha@x.in')).toBeNull()
      return { status: 200 }
    })
    const res = await POST(req(JSON.stringify(activity)))
    expect(res.status).toBe(200)
    expect(appUserByEmail).toHaveBeenCalledWith('asha@x.in')
  })

  it('wires follow-up card clicks to lib/data followUpAction', async () => {
    env.mockReturnValue({ appId: 'app', password: 'p', tenantId: 't' })
    verify.mockResolvedValue(undefined)
    followUpAction.mockResolvedValue({ id: 'f1' })
    handle.mockImplementation(async (_a: unknown, deps: { followUps: { action: (...a: unknown[]) => Promise<unknown> } }) => {
      expect(await deps.followUps.action({ id: 'u1' }, 'f1', 'done')).toEqual({ id: 'f1' })
      return { status: 200 }
    })
    const res = await POST(req(JSON.stringify(activity)))
    expect(res.status).toBe(200)
    expect(followUpAction).toHaveBeenCalledWith({ id: 'u1' }, 'f1', 'done')
  })
})
