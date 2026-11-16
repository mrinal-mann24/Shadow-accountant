// Left nav per role. Pure, so it is unit tested. Routes belong to the UI agents (see docs/agents/notes/auth.md).
import type { AppUser } from '@/lib/auth/types'

export type NavItem = { href: string; label: string; icon: 'home' | 'clients' | 'tickets' | 'ask' | 'team' | 'assignment' | 'users' | 'system' }

const ACCOUNTANT: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'home' },
  { href: '/clients', label: 'Clients', icon: 'clients' },
  { href: '/tickets', label: 'Tickets', icon: 'tickets' },
  { href: '/ask', label: 'Ask AI', icon: 'ask' },
]
const TEAM: NavItem = { href: '/admin', label: 'Team', icon: 'team' }
const ASSIGNMENT: NavItem = { href: '/admin/assignment', label: 'Assignment', icon: 'assignment' }
const USERS: NavItem = { href: '/admin/users', label: 'Users and roles', icon: 'users' }
const SYSTEM: NavItem = { href: '/engineer', label: 'System', icon: 'system' }

/** An engineer viewing as an accountant has role senior_accountant, so gets the accountant nav. */
export function navForUser(user: AppUser): NavItem[] {
  switch (user.role) {
    case 'admin':
      return [...ACCOUNTANT, TEAM, ASSIGNMENT, USERS]
    case 'engineer':
      return [...ACCOUNTANT, TEAM, SYSTEM]
    default:
      return ACCOUNTANT
  }
}

/** Active when on the item's page or below it; '/admin' is not active on '/admin/users' (its own item). */
export function isActive(pathname: string, href: string, items: readonly NavItem[]): boolean {
  if (pathname !== href && !pathname.startsWith(href + '/')) return false
  return !items.some((i) => i.href !== href && i.href.startsWith(href + '/') && (pathname === i.href || pathname.startsWith(i.href + '/')))
}
