import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---- mocks (no network, no Supabase) ---------------------------------------------------------
const jar = new Map<string, string>()
let authUser: Record<string, unknown> | null = null
const VAS = [
  { va_id: 'va-1', va_name: 'Priya Sharma', email: 'priya@aiaccountant.com' },
  { va_id: 'va-2', va_name: 'Rahul Mehta', email: 'Rahul@AIAccountant.com' },
]

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined) }),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`)
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user: authUser } }) } }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => ({
    from: () => ({ select: () => ({ order: async () => ({ data: VAS, error: null }) }) }),
  }),
}))

const { getCurrentUser, requireUser, getAuthState } = await import('./session')

const signIn = (email: string, role?: string, name = 'Test User') => {
  authUser = {
    id: 'u-1',
    email,
    email_confirmed_at: '2026-11-01T00:00:00Z',
    app_metadata: { provider: 'azure', providers: ['azure'], ...(role ? { role } : {}) },
    identities: [{ provider: 'azure' }],
    user_metadata: { full_name: name },
  }
}

beforeEach(() => {
  jar.clear()
  authUser = null
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getCurrentUser', () => {
  it('returns null when signed out', async () => {
    expect(await getCurrentUser()).toBeNull()
    await expect(requireUser()).rejects.toThrow('REDIRECT:/login')
  })

  it('maps a vas email (any case) to a senior accountant with vaId', async () => {
    signIn('rahul@aiaccountant.com')
    expect(await getCurrentUser()).toEqual({
      id: 'u-1',
      email: 'rahul@aiaccountant.com',
      name: 'Test User',
      role: 'senior_accountant',
      vaId: 'va-2',
    })
  })

  it('gives no access to an unknown email with no role', async () => {
    signIn('stranger@aiaccountant.com')
    expect(await getCurrentUser()).toBeNull()
    expect(await getAuthState()).toEqual({ status: 'no_access', email: 'stranger@aiaccountant.com' })
    await expect(requireUser()).rejects.toThrow('REDIRECT:/no-access')
  })

  it('gives no access to a matching email from a non-Microsoft sign in or an unconfirmed email', async () => {
    signIn('priya@aiaccountant.com', 'admin')
    authUser = { ...authUser!, app_metadata: { provider: 'email', providers: ['email'], role: 'admin' }, identities: [{ provider: 'email' }] }
    expect(await getCurrentUser()).toBeNull()
    expect(await getAuthState()).toEqual({ status: 'no_access', email: 'priya@aiaccountant.com' })
    signIn('priya@aiaccountant.com')
    authUser = { ...authUser!, email_confirmed_at: null }
    expect(await getCurrentUser()).toBeNull()
  })

  it('uses app_metadata.role', async () => {
    signIn('boss@aiaccountant.com', 'admin')
    expect(await getCurrentUser()).toMatchObject({ role: 'admin', vaId: null })
  })
})

describe('view as', () => {
  it('scopes an engineer to the chosen accountant, read-only', async () => {
    signIn('eng@aiaccountant.com', 'engineer')
    jar.set('view_as_va', 'va-1')
    const u = await getCurrentUser()
    expect(u).toMatchObject({ role: 'senior_accountant', vaId: 'va-1', viewingAs: { vaId: 'va-1', name: 'Priya Sharma' } })
    const state = await getAuthState()
    expect(state.status === 'ok' && state.signedInUser.role).toBe('engineer')
    // engineer-only pages bounce to /home while viewing as
    await expect(requireUser(['engineer'])).rejects.toThrow('REDIRECT:/home')
  })

  it('ignores the cookie for admins and accountants', async () => {
    signIn('boss@aiaccountant.com', 'admin')
    jar.set('view_as_va', 'va-1')
    expect(await getCurrentUser()).toMatchObject({ role: 'admin', vaId: null })
    expect((await getCurrentUser())?.viewingAs).toBeUndefined()

    signIn('rahul@aiaccountant.com')
    expect(await getCurrentUser()).toMatchObject({ role: 'senior_accountant', vaId: 'va-2' })
  })

  it('ignores an unknown va id', async () => {
    signIn('eng@aiaccountant.com', 'engineer')
    jar.set('view_as_va', 'va-unknown')
    expect(await getCurrentUser()).toMatchObject({ role: 'engineer', vaId: null })
  })
})

describe('requireUser roles', () => {
  it('redirects a wrong role to /home and returns the user otherwise', async () => {
    signIn('priya@aiaccountant.com')
    await expect(requireUser(['admin'])).rejects.toThrow('REDIRECT:/home')
    expect(await requireUser(['senior_accountant', 'admin'])).toMatchObject({ vaId: 'va-1' })
  })
})

describe('dev login', () => {
  it('signs in as DEV_LOGIN_EMAIL outside production when the cookie is set', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('DEV_LOGIN_EMAIL', 'priya@aiaccountant.com')
    expect(await getCurrentUser()).toBeNull() // no cookie yet
    jar.set('dev_login', '1')
    expect(await getCurrentUser()).toMatchObject({ email: 'priya@aiaccountant.com', role: 'senior_accountant', vaId: 'va-1' })
    vi.stubEnv('DEV_LOGIN_ROLE', 'engineer')
    expect(await getCurrentUser()).toMatchObject({ role: 'engineer' })
  })

  it('is never active in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DEV_LOGIN_EMAIL', 'priya@aiaccountant.com')
    jar.set('dev_login', '1')
    expect(await getCurrentUser()).toBeNull()
  })
})
