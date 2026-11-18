import type { User } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import type { VaRecord } from '@/lib/auth/roles'
import type { AppUser } from '@/lib/auth/types'
import {
  appUserByEmail,
  appUserByEmailWith,
  cachedResolver,
  isGuestEmail,
  MAX_USER_PAGES,
  resetIdentityCache,
  USERS_PER_PAGE,
  type IdentityDeps,
} from './identity'
import type { ResolveUser } from './types'

const vas: VaRecord[] = [
  { va_id: 'va1', va_name: 'Asha Rao', email: 'Asha@Example.com' },
  { va_id: 'va2', va_name: 'Ravi', email: null },
]

function authUser(over: Partial<User> & { email: string }): User {
  return {
    id: `auth-${over.email}`,
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00Z',
    email_confirmed_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'azure', providers: ['azure'] },
    user_metadata: {},
    identities: [],
    ...over,
  } as User
}

function deps(users: User[]): IdentityDeps & { pages: number[] } {
  const pages: number[] = []
  return {
    pages,
    loadVas: async () => vas,
    listUsers: async (page) => {
      pages.push(page)
      return users.slice((page - 1) * USERS_PER_PAGE, page * USERS_PER_PAGE)
    },
  }
}

describe('appUserByEmailWith', () => {
  it('matches the shared ResolveUser contract', () => {
    const r: ResolveUser = appUserByEmail
    expect(typeof r).toBe('function')
  })

  it('a trusted auth user with an explicit role gets that role and the auth id', async () => {
    const d = deps([authUser({ email: 'admin@example.com', app_metadata: { provider: 'azure', role: 'admin' }, user_metadata: { full_name: 'Neha Admin' } })])
    expect(await appUserByEmailWith(d, ' ADMIN@example.com ')).toEqual({
      id: 'auth-admin@example.com',
      email: 'admin@example.com',
      name: 'Neha Admin',
      role: 'admin',
      vaId: null,
    })
  })

  it('a vas match with a trusted auth user and no role is a senior accountant', async () => {
    const d = deps([authUser({ email: 'asha@example.com' })])
    expect(await appUserByEmailWith(d, 'asha@example.com')).toEqual({
      id: 'auth-asha@example.com',
      email: 'asha@example.com',
      name: 'Asha Rao',
      role: 'senior_accountant',
      vaId: 'va1',
    })
  })

  it('a vas match with no auth user gets a teams: id', async () => {
    const user = await appUserByEmailWith(deps([]), 'asha@example.com')
    expect(user).toMatchObject({ id: 'teams:asha@example.com', role: 'senior_accountant', vaId: 'va1', name: 'Asha Rao' })
  })

  it('an untrusted auth user never contributes a role', async () => {
    const untrusted = authUser({
      email: 'asha@example.com',
      app_metadata: { provider: 'email', providers: ['email'], role: 'admin' },
    })
    const user = await appUserByEmailWith(deps([untrusted]), 'asha@example.com')
    expect(user).toMatchObject({ id: 'teams:asha@example.com', role: 'senior_accountant', vaId: 'va1' })

    const unconfirmed = authUser({ email: 'boss@example.com', email_confirmed_at: undefined, app_metadata: { provider: 'azure', role: 'admin' } })
    expect(await appUserByEmailWith(deps([unconfirmed]), 'boss@example.com')).toBeNull()
  })

  it('returns null for an unknown email, a trusted user with no role and no vas row, or a bad email', async () => {
    expect(await appUserByEmailWith(deps([]), 'nobody@example.com')).toBeNull()
    expect(await appUserByEmailWith(deps([authUser({ email: 'x@example.com' })]), 'x@example.com')).toBeNull()
    expect(await appUserByEmailWith(deps([]), '')).toBeNull()
    expect(await appUserByEmailWith(deps([]), 'not-an-email')).toBeNull()
  })

  it('pages through auth users and stops at the page limit', async () => {
    const many = Array.from({ length: USERS_PER_PAGE * 2 + 5 }, (_, i) => authUser({ email: `u${i}@example.com` }))
    const found = deps([...many, authUser({ email: 'late@example.com', app_metadata: { provider: 'azure', role: 'engineer' } })])
    expect((await appUserByEmailWith(found, 'late@example.com'))?.role).toBe('engineer')
    expect(found.pages).toEqual([1, 2, 3])

    const endless: IdentityDeps & { calls: number } = {
      calls: 0,
      loadVas: async () => vas,
      listUsers: vi.fn(async () => {
        endless.calls++
        return Array.from({ length: USERS_PER_PAGE }, (_, i) => authUser({ email: `p${i}@example.com` }))
      }),
    }
    expect(await appUserByEmailWith(endless, 'missing@example.com')).toBeNull()
    expect(endless.calls).toBe(MAX_USER_PAGES)
  })

  it('passes errors from the auth or vas lookups through', async () => {
    const d: IdentityDeps = { loadVas: async () => vas, listUsers: async () => Promise.reject(new Error('auth down')) }
    await expect(appUserByEmailWith(d, 'asha@example.com')).rejects.toThrow('auth down')
  })
})

describe('guests', () => {
  it('a guest UPN (#EXT#, any case) is null even with a vas row or a trusted admin user', async () => {
    const guest = 'asha_example.com#EXT#@tenant.onmicrosoft.com'
    const d = deps([authUser({ email: guest, app_metadata: { provider: 'azure', role: 'admin' } })])
    expect(await appUserByEmailWith(d, guest)).toBeNull()
    expect(await appUserByEmailWith(d, guest.toLowerCase())).toBeNull()
    expect(d.pages).toEqual([])
    expect(isGuestEmail('x#ext#@t.onmicrosoft.com')).toBe(true)
    expect(isGuestEmail('asha@example.com')).toBe(false)
    expect(isGuestEmail(null)).toBe(false)
  })
})

describe('cachedResolver', () => {
  const asha: AppUser = { id: 'u1', email: 'asha@example.com', name: 'Asha', role: 'senior_accountant', vaId: 'va1' }

  it('reuses a result and a null per normalised email for 60 s, then looks up again', async () => {
    let t = 0
    const resolve = vi.fn(async (email: string) => (email.trim().toLowerCase() === 'asha@example.com' ? asha : null))
    const c = cachedResolver(resolve, { now: () => t })
    expect(await c.resolve('asha@example.com')).toEqual(asha)
    expect(await c.resolve(' ASHA@example.com ')).toEqual(asha)
    expect(await c.resolve('nobody@example.com')).toBeNull()
    expect(await c.resolve('nobody@example.com')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(2)
    t = 59_999
    await c.resolve('asha@example.com')
    expect(resolve).toHaveBeenCalledTimes(2)
    t = 60_000
    await c.resolve('asha@example.com')
    expect(resolve).toHaveBeenCalledTimes(3)
    c.reset()
    await c.resolve('asha@example.com')
    expect(resolve).toHaveBeenCalledTimes(4)
  })

  it('does not cache errors and stays bounded', async () => {
    const resolve = vi.fn(async (email: string): Promise<AppUser | null> => {
      if (email === 'down@example.com') throw new Error('db down')
      return null
    })
    const c = cachedResolver(resolve, { max: 2, now: () => 0 })
    await expect(c.resolve('down@example.com')).rejects.toThrow('db down')
    await expect(c.resolve('down@example.com')).rejects.toThrow('db down')
    expect(resolve).toHaveBeenCalledTimes(2)
    await c.resolve('a@example.com')
    await c.resolve('b@example.com')
    await c.resolve('c@example.com') // drops a@
    await c.resolve('a@example.com')
    expect(resolve.mock.calls.filter(([e]) => e === 'a@example.com')).toHaveLength(2)
  })

  it('resetIdentityCache is exported for tests', () => {
    expect(() => resetIdentityCache()).not.toThrow()
  })
})
