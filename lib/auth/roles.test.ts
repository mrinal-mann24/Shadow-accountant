import { describe, expect, it } from 'vitest'
import {
  applyViewAs,
  assertNotViewingAs,
  canSeeAllClients,
  devLoginEmail,
  findVaByEmail,
  isPublicPath,
  isTrustedSessionUser,
  resolveAppUser,
  safeNextPath,
  ViewAsReadOnlyError,
  type AuthIdentity,
  type VaRecord,
} from './roles'
import type { AppUser } from './types'

const VAS: VaRecord[] = [
  { va_id: 'va-1', va_name: 'Priya Sharma', email: 'Priya.Sharma@AIAccountant.com' },
  { va_id: 'va-2', va_name: 'Rahul Mehta', email: ' rahul@aiaccountant.com ' },
  { va_id: 'va-3', va_name: 'No Email', email: null },
]

const id = (over: Partial<AuthIdentity> = {}): AuthIdentity => ({
  id: 'u-1',
  email: 'priya.sharma@aiaccountant.com',
  name: 'Priya S',
  appRole: undefined,
  ...over,
})

describe('findVaByEmail', () => {
  it('matches case-insensitively and ignores surrounding spaces', () => {
    expect(findVaByEmail(VAS, 'PRIYA.SHARMA@aiaccountant.com')?.va_id).toBe('va-1')
    expect(findVaByEmail(VAS, 'rahul@aiaccountant.com')?.va_id).toBe('va-2')
  })
  it('returns null for unknown or empty email, never matching null vas emails', () => {
    expect(findVaByEmail(VAS, 'someone@else.com')).toBeNull()
    expect(findVaByEmail(VAS, '')).toBeNull()
    expect(findVaByEmail(VAS, '   ')).toBeNull()
  })
})

describe('resolveAppUser (role resolution)', () => {
  it('defaults to senior_accountant when no role is set and the email matches vas', () => {
    expect(resolveAppUser(id(), VAS[0])).toEqual({
      id: 'u-1',
      email: 'priya.sharma@aiaccountant.com',
      name: 'Priya S',
      role: 'senior_accountant',
      vaId: 'va-1',
    })
  })
  it('uses app_metadata.role when valid', () => {
    expect(resolveAppUser(id({ appRole: 'admin' }), VAS[0])?.role).toBe('admin')
    expect(resolveAppUser(id({ appRole: 'engineer' }), null)).toMatchObject({ role: 'engineer', vaId: null })
  })
  it('gives no access to an unknown email with no role', () => {
    expect(resolveAppUser(id({ email: 'new@aiaccountant.com' }), null)).toBeNull()
  })
  it('treats an invalid role as no role', () => {
    expect(resolveAppUser(id({ appRole: 'superuser' }), null)).toBeNull()
    expect(resolveAppUser(id({ appRole: 'ADMIN' }), VAS[0])?.role).toBe('senior_accountant')
    expect(resolveAppUser(id({ appRole: 42 }), VAS[0])?.role).toBe('senior_accountant')
  })
  it('allows an explicit senior_accountant with no vas row (sees no clients)', () => {
    expect(resolveAppUser(id({ appRole: 'senior_accountant' }), null)).toMatchObject({ vaId: null })
  })
  it('falls back to vas name, then email, for the display name', () => {
    expect(resolveAppUser(id({ name: null }), VAS[0])?.name).toBe('Priya Sharma')
    expect(resolveAppUser(id({ name: '  ', appRole: 'admin' }), null)?.name).toBe('priya.sharma@aiaccountant.com')
  })
})

const engineer: AppUser = { id: 'e', email: 'eng@x.com', name: 'Eng', role: 'engineer', vaId: null }
const admin: AppUser = { id: 'a', email: 'adm@x.com', name: 'Adm', role: 'admin', vaId: null }
const accountant: AppUser = { id: 's', email: 's@x.com', name: 'S', role: 'senior_accountant', vaId: 'va-2' }

describe('applyViewAs (view-as scoping)', () => {
  it('scopes an engineer to the target accountant', () => {
    const u = applyViewAs(engineer, VAS[0])
    expect(u).toEqual({
      ...engineer,
      role: 'senior_accountant',
      vaId: 'va-1',
      viewingAs: { vaId: 'va-1', name: 'Priya Sharma' },
    })
    expect(canSeeAllClients(u)).toBe(false)
    expect(() => assertNotViewingAs(u)).toThrow(ViewAsReadOnlyError)
  })
  it('is ignored for admins and accountants', () => {
    expect(applyViewAs(admin, VAS[0])).toBe(admin)
    expect(applyViewAs(accountant, VAS[0])).toBe(accountant)
  })
  it('is ignored when the target is unknown', () => {
    expect(applyViewAs(engineer, null)).toBe(engineer)
  })
})

describe('canSeeAllClients / assertNotViewingAs', () => {
  it('admin and engineer see all; accountant does not', () => {
    expect(canSeeAllClients(admin)).toBe(true)
    expect(canSeeAllClients(engineer)).toBe(true)
    expect(canSeeAllClients(accountant)).toBe(false)
  })
  it('does not throw for normal users', () => {
    expect(() => assertNotViewingAs(admin)).not.toThrow()
    expect(() => assertNotViewingAs(accountant)).not.toThrow()
  })
})

describe('safeNextPath', () => {
  it('keeps same-site relative paths', () => {
    expect(safeNextPath('/clients/abc?tab=tickets')).toBe('/clients/abc?tab=tickets')
  })
  it('rejects open redirects and empty values', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'evil', '', null, undefined]) {
      expect(safeNextPath(bad)).toBe('/home')
    }
  })
})

describe('isPublicPath', () => {
  it('allows login, auth, job and webhook routes', () => {
    for (const p of ['/login', '/auth/callback', '/auth/sign-out', '/api/jobs/council', '/api/webhooks/hubspot']) {
      expect(isPublicPath(p)).toBe(true)
    }
  })
  it('protects everything else', () => {
    for (const p of ['/', '/home', '/clients/1', '/no-access', '/api/chat', '/loginx', '/authx', '/api/jobs']) {
      expect(isPublicPath(p)).toBe(false)
    }
  })
})

describe('devLoginEmail', () => {
  it('is on only outside production with DEV_LOGIN_EMAIL set', () => {
    expect(devLoginEmail({ NODE_ENV: 'development', DEV_LOGIN_EMAIL: ' dev@x.com ' })).toBe('dev@x.com')
    expect(devLoginEmail({ NODE_ENV: 'test', DEV_LOGIN_EMAIL: 'dev@x.com' })).toBe('dev@x.com')
  })
  it('is never on in production', () => {
    expect(devLoginEmail({ NODE_ENV: 'production', DEV_LOGIN_EMAIL: 'dev@x.com' })).toBeNull()
  })
  it('is off without an email', () => {
    expect(devLoginEmail({ NODE_ENV: 'development' })).toBeNull()
    expect(devLoginEmail({ NODE_ENV: 'development', DEV_LOGIN_EMAIL: '  ' })).toBeNull()
  })
})

describe('isTrustedSessionUser (Microsoft SSO only)', () => {
  const azure = { email_confirmed_at: '2026-11-01T00:00:00Z', app_metadata: { provider: 'azure', providers: ['azure'] }, identities: [{ provider: 'azure' }] }

  it('accepts a confirmed azure-only account', () => {
    expect(isTrustedSessionUser(azure)).toBe(true)
  })

  it('rejects an unconfirmed email', () => {
    expect(isTrustedSessionUser({ ...azure, email_confirmed_at: null })).toBe(false)
    expect(isTrustedSessionUser({ ...azure, email_confirmed_at: undefined })).toBe(false)
  })

  it('rejects email / password, magic link and other providers', () => {
    expect(isTrustedSessionUser({ ...azure, app_metadata: { provider: 'email', providers: ['email'] }, identities: [{ provider: 'email' }] })).toBe(false)
    expect(isTrustedSessionUser({ ...azure, app_metadata: { provider: 'google' }, identities: [{ provider: 'google' }] })).toBe(false)
  })

  it('rejects an azure account that also has another identity linked', () => {
    expect(isTrustedSessionUser({ ...azure, app_metadata: { provider: 'azure', providers: ['azure', 'email'] } })).toBe(false)
    expect(isTrustedSessionUser({ ...azure, identities: [{ provider: 'azure' }, { provider: 'email' }] })).toBe(false)
  })

  it('rejects an account with no provider information', () => {
    expect(isTrustedSessionUser({ email_confirmed_at: '2026-11-01T00:00:00Z' })).toBe(false)
  })
})
