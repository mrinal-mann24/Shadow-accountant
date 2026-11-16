// Pure: tabs across the Admin pages per role. Client-safe, unit tested.
export type SubnavItem = { href: string; label: string }

/** Admin sees all three tabs; an engineer only sees Team (assignment and users are admin only). */
export function adminSubnav(role: string): SubnavItem[] {
  const team = { href: '/admin', label: 'Team' }
  if (role !== 'admin') return [team]
  return [team, { href: '/admin/assignment', label: 'Assignment' }, { href: '/admin/users', label: 'Users and roles' }]
}
