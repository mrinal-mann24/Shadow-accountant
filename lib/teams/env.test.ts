import { afterEach, describe, expect, it, vi } from 'vitest'
import { siteUrl, teamsEnv } from './env'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('teamsEnv', () => {
  it('returns trimmed values when all three are set', () => {
    vi.stubEnv('TEAMS_BOT_APP_ID', ' app ')
    vi.stubEnv('TEAMS_BOT_APP_PASSWORD', 'secret\n')
    vi.stubEnv('TEAMS_BOT_TENANT_ID', 'tenant')
    expect(teamsEnv()).toEqual({ appId: 'app', password: 'secret', tenantId: 'tenant' })
  })

  it('returns null when any value is missing or blank', () => {
    vi.stubEnv('TEAMS_BOT_APP_ID', 'app')
    vi.stubEnv('TEAMS_BOT_APP_PASSWORD', '   ')
    vi.stubEnv('TEAMS_BOT_TENANT_ID', 'tenant')
    expect(teamsEnv()).toBeNull()
  })
})

describe('siteUrl', () => {
  it('strips trailing slashes', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', ' https://example.test/// ')
    expect(siteUrl()).toBe('https://example.test')
  })

  it('falls back to the production URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(siteUrl()).toBe('https://shadow-accountant-two.vercel.app')
  })
})
