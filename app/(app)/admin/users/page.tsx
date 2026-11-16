import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RoleSelect } from '@/components/admin/role-select'
import { formatDateTime } from '@/components/admin/format'
import { EmptyState, LoadError, PageHeader, Section, Subnav, adminSubnav } from '@/components/admin/states'
import { requireUser } from '@/lib/auth/session'
import { ROLE_LABELS, type AppUser } from '@/lib/auth/types'
import { listAppUsers } from '@/lib/auth/users'

export const metadata = { title: 'Users and roles' }

async function load(user: AppUser) {
  try {
    return { ok: true as const, users: await listAppUsers(user) }
  } catch (e) {
    console.error('[admin] list users failed', e)
    return { ok: false as const }
  }
}

export default async function UsersPage() {
  const user = await requireUser(['admin'])
  const data = await load(user)

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Users and roles" description="Who can sign in and what they can see." />
      <Subnav items={adminSubnav(user.role)} current="/admin/users" />

      <Section
        title="Users"
        description={
          <>
            People appear here after they sign in once. With no role set, a person whose email matches an accountant
            record gets Senior Accountant access; anyone else has no access. You cannot change your own role.
          </>
        }
      >
        {!data.ok ? (
          <LoadError what="users" />
        ) : data.users.length === 0 ? (
          <EmptyState>Nobody has signed in yet.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Access today</TableHead>
                <TableHead>Accountant record</TableHead>
                <TableHead>Last sign in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.users.map((u) => {
                const self = u.id === user.id
                return (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="font-medium">
                        {u.name ?? u.email} {self && <Badge variant="secondary">You</Badge>}
                      </div>
                      {u.name && <div className="text-xs text-muted-foreground">{u.email}</div>}
                    </TableCell>
                    <TableCell>
                      <RoleSelect userId={u.id} email={u.email} role={u.role} disabled={self} />
                    </TableCell>
                    <TableCell>
                      {u.effectiveRole ? (
                        <span>
                          {ROLE_LABELS[u.effectiveRole]}
                          {!u.role && <span className="text-xs text-muted-foreground"> (from email)</span>}
                        </span>
                      ) : (
                        <span className="text-warning">No access</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{u.vaName ?? 'None'}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(u.lastSignInAt)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  )
}
