import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const base = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test',
}

async function load() {
  vi.resetModules()
  return import('./env')
}

function stubAll(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v)
}

const ALL = [
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL_A', 'OPENROUTER_MODEL_B', 'OPENROUTER_EMBED_MODEL', 'CRON_SECRET', 'JOBS_WRITE_ENABLED',
  'HUBSPOT_ACCESS_TOKEN', 'HUBSPOT_WEBHOOK_SECRET', 'DEV_LOGIN_EMAIL', 'APP_TIMEZONE',
]

beforeEach(() => stubAll(Object.fromEntries(ALL.map((k) => [k, undefined]))))
afterEach(() => vi.unstubAllEnvs())

describe('serverEnv', () => {
  it('does not validate at import time', async () => {
    await expect(load()).resolves.toBeDefined()
  })

  it('returns parsed values with defaults', async () => {
    stubAll(base)
    const { serverEnv } = await load()
    const env = serverEnv()
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(base.NEXT_PUBLIC_SUPABASE_URL)
    expect(env.JOBS_WRITE_ENABLED).toBe(false)
    expect(env.APP_TIMEZONE).toBe('Asia/Kolkata')
    expect(env.OPENROUTER_API_KEY).toBeUndefined()
  })

  it('treats blank optional values as unset and parses the write flag', async () => {
    stubAll({ ...base, CRON_SECRET: '  ', JOBS_WRITE_ENABLED: 'TRUE', APP_TIMEZONE: 'UTC' })
    const { serverEnv } = await load()
    const env = serverEnv()
    expect(env.CRON_SECRET).toBeUndefined()
    expect(env.JOBS_WRITE_ENABLED).toBe(true)
    expect(env.APP_TIMEZONE).toBe('UTC')
  })

  it('names every missing required variable', async () => {
    stubAll({ NEXT_PUBLIC_SUPABASE_URL: 'not a url' })
    const { serverEnv } = await load()
    expect(() => serverEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
    expect(() => serverEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY is not set/)
    expect(() => serverEnv()).toThrow(/SUPABASE_SERVICE_ROLE_KEY is not set/)
  })
})

describe('publicEnv', () => {
  it('returns the two public values', async () => {
    stubAll(base)
    const { publicEnv } = await load()
    expect(publicEnv()).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: base.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: base.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    })
  })

  it('throws when missing', async () => {
    const { publicEnv } = await load()
    expect(() => publicEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
  })
})
