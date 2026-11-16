import type { Metadata } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatAgo, formatDateTime } from '@/components/accountant/logic'
import { EmptyState, HealthValue, PageHeader } from '@/components/accountant/ui'
import { requireUser } from '@/lib/auth/session'
import { canSeeAllClients } from '@/lib/auth/roles'
import { listClients } from '@/lib/data'

export const metadata: Metadata = { title: 'Clients' }
export const dynamic = 'force-dynamic'

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; status?: string | string[] }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const q = first(params.q)?.trim().slice(0, 100) ?? ''
  const inactive = first(params.status) === 'inactive'
  const clients = await listClients(user, { ...(q ? { search: q } : {}), status: inactive ? 'inactive' : 'active' })
  const now = new Date()
  const showAccountant = canSeeAllClients(user)
  const tabHref = (status: 'active' | 'inactive') => {
    const sp = new URLSearchParams()
    if (q) sp.set('q', q)
    if (status === 'inactive') sp.set('status', 'inactive')
    const s = sp.toString()
    return s ? `/clients?${s}` : '/clients'
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Clients"
        description={`${clients.length} ${inactive ? 'inactive ' : ''}${clients.length === 1 ? 'client' : 'clients'}${q ? ` matching "${q}"` : ''}`}
      />

      <nav aria-label="Client status" className="mb-4 flex gap-2 text-sm">
        {(['active', 'inactive'] as const).map((s) => {
          const current = (s === 'inactive') === inactive
          return (
            <Link
              key={s}
              href={tabHref(s)}
              aria-current={current ? 'page' : undefined}
              className={
                current
                  ? 'rounded-md border border-foreground px-3 py-1 font-medium'
                  : 'rounded-md border px-3 py-1 text-muted-foreground hover:bg-secondary'
              }
            >
              {s === 'active' ? 'Active' : 'Inactive (churned or parked)'}
            </Link>
          )
        })}
      </nav>

      <form role="search" className="mb-4 flex max-w-xl gap-2" action="/clients">
        {inactive && <input type="hidden" name="status" value="inactive" />}
        <label htmlFor="client-search" className="sr-only">
          Search clients
        </label>
        <Input id="client-search" name="q" defaultValue={q} placeholder="Search by name, legal name or group" />
        <Button type="submit">
          <Search aria-hidden />
          Search
        </Button>
        {q && (
          <Button asChild variant="ghost">
            <Link href="/clients">Clear</Link>
          </Button>
        )}
      </form>

      {clients.length === 0 ? (
        <EmptyState>
          {q
            ? 'No clients match your search.'
            : inactive
              ? 'No inactive clients.'
              : 'No clients are assigned to you yet. Ask an Admin to assign clients.'}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="hidden grid-cols-[minmax(0,3fr)_7rem_7rem_minmax(0,2fr)] gap-4 border-b bg-secondary px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span>Client</span>
            <span>Health</span>
            <span>Open tickets</span>
            <span>Last message</span>
          </div>
          <ul className="divide-y">
            {clients.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/clients/${c.id}`}
                  className="grid gap-1 px-4 py-3 hover:bg-secondary md:grid-cols-[minmax(0,3fr)_7rem_7rem_minmax(0,2fr)] md:items-center md:gap-4"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[c.legalName && c.legalName !== c.name ? c.legalName : null, showAccountant ? (c.vaName ?? 'Unassigned') : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="text-sm">
                    <span className="text-xs text-muted-foreground md:hidden">Health </span>
                    <HealthValue score={c.serviceScore} delta={c.serviceDelta} />
                  </span>
                  <span className="text-sm tabular-nums">
                    <span className="text-xs text-muted-foreground md:hidden">Open tickets </span>
                    {c.openTickets}
                    {c.openEscalations > 0 && (
                      <span className="ml-1 text-xs text-destructive">
                        ({c.openEscalations} {c.openEscalations === 1 ? 'escalation' : 'escalations'})
                      </span>
                    )}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    <span className="text-xs md:hidden">Last message </span>
                    {c.lastMessageAt ? (
                      <time dateTime={c.lastMessageAt} title={formatDateTime(c.lastMessageAt)}>
                        {formatAgo(c.lastMessageAt, now)}
                      </time>
                    ) : (
                      'No messages yet'
                    )}
                    {(c.unansweredCount ?? 0) > 0 && <span className="ml-2 text-xs text-destructive">Waiting for reply</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
