import { describe, expect, it } from 'vitest'
import type { AppUser } from '@/lib/auth/types'
import { isActive, navForUser } from './nav'

const base: AppUser = { id: '1', email: 'a@x.com', name: 'A', role: 'senior_accountant', vaId: 'va-1' }
const labels = (u: AppUser) => navForUser(u).map((i) => i.label)

describe('navForUser', () => {
  it('senior accountant: Home, Clients, Tickets, Ask AI', () => {
    expect(labels(base)).toEqual(['Home', 'Clients', 'Tickets', 'Ask AI'])
  })
  it('admin adds Team, Assignment and Users and roles', () => {
    expect(labels({ ...base, role: 'admin' })).toEqual(['Home', 'Clients', 'Tickets', 'Ask AI', 'Team', 'Assignment', 'Users and roles'])
  })
  it('engineer adds Team and System', () => {
    expect(labels({ ...base, role: 'engineer' })).toEqual(['Home', 'Clients', 'Tickets', 'Ask AI', 'Team', 'System'])
  })
  it('engineer viewing as an accountant gets the accountant nav', () => {
    const viewing: AppUser = { ...base, role: 'senior_accountant', viewingAs: { vaId: 'va-1', name: 'P' } }
    expect(labels(viewing)).toEqual(['Home', 'Clients', 'Tickets', 'Ask AI'])
  })
})

describe('isActive', () => {
  const items = navForUser({ ...base, role: 'admin' })
  it('matches the page and its children', () => {
    expect(isActive('/clients', '/clients', items)).toBe(true)
    expect(isActive('/clients/abc', '/clients', items)).toBe(true)
    expect(isActive('/clientsx', '/clients', items)).toBe(false)
  })
  it('does not mark Team active on Assignment or Users and roles', () => {
    expect(isActive('/admin/users', '/admin', items)).toBe(false)
    expect(isActive('/admin/assignment', '/admin', items)).toBe(false)
    expect(isActive('/admin/assignment', '/admin/assignment', items)).toBe(true)
    expect(isActive('/admin/users', '/admin/users', items)).toBe(true)
    expect(isActive('/admin', '/admin', items)).toBe(true)
  })
})
