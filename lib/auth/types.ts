// Shared auth types. Safe to import from client and server code.

export type Role = 'senior_accountant' | 'admin' | 'engineer'

export const ROLES: readonly Role[] = ['senior_accountant', 'admin', 'engineer']

export const ROLE_LABELS: Record<Role, string> = {
  senior_accountant: 'Senior Accountant',
  admin: 'Admin',
  engineer: 'Engineer',
}

export type AppUser = {
  id: string
  email: string
  name: string
  role: Role
  vaId: string | null
  /** Set only while an engineer is using "view as". The user is then scoped as that accountant and is read-only. */
  viewingAs?: { vaId: string; name: string }
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}
