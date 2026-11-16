import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AssignSelect } from '@/components/admin/assign-select'
import { formatScore, scoreClass } from '@/components/admin/format'
import { sortForAssignment } from '@/components/admin/kpis'
import { EmptyState, LoadError, PageHeader, Section, Subnav, adminSubnav } from '@/components/admin/states'
import { requireUser } from '@/lib/auth/session'
import type { AppUser } from '@/lib/auth/types'
import { listClients, listVas } from '@/lib/data'

export const metadata = { title: 'Client assignment' }

async function load(user: AppUser, search: string) {
  try {
    const [clients, vas] = await Promise.all([listClients(user, search ? { search } : undefined), listVas(user)])
    return { ok: true as const, clients: sortForAssignment(clients), vas }
  } catch (e) {
    console.error('[admin] assignment load failed', e)
    return { ok: false as const }
  }
}

export default async function AssignmentPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const user = await requireUser(['admin'])
  const raw = (await searchParams).q
  const search = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 100) ?? ''
  const data = await load(user, search)

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Client assignment" description="Choose the accountant for each client. Changes save straight away." />
      <Subnav items={adminSubnav(user.role)} current="/admin/assignment" />

      {!data.ok ? (
        <LoadError what="clients and accountants" />
      ) : (
        <div className="flex flex-col gap-6">
          {data.vas.length > 0 && (
            <div className="flex flex-wrap gap-2 text-sm">
              {data.vas.map((v) => (
                <span key={v.id} className="rounded-md border px-3 py-1">
                  {v.name} <span className="text-muted-foreground tabular-nums">({v.clientCount})</span>
                </span>
              ))}
            </div>
          )}

          <Section
            title="Clients"
            description="Unassigned clients are listed first. New clients won in HubSpot arrive here without an accountant."
          >
            <form method="get" className="mb-4 flex max-w-md gap-2" role="search">
              <Input name="q" defaultValue={search} placeholder="Search by client, legal or group name" aria-label="Search clients" />
              <Button type="submit">Search</Button>
              {search && (
                <Button asChild variant="ghost">
                  <Link href="/admin/assignment">Clear</Link>
                </Button>
              )}
            </form>

            {data.vas.length === 0 && <EmptyState>No accountants found. Add accountants to the team list first.</EmptyState>}

            {data.clients.length === 0 ? (
              <EmptyState>{search ? `No clients match "${search}".` : 'No clients yet.'}</EmptyState>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>WhatsApp group</TableHead>
                    <TableHead>Deal stage</TableHead>
                    <TableHead className="text-right">Health</TableHead>
                    <TableHead className="text-right">Open tickets</TableHead>
                    <TableHead>Accountant</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.clients.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link href={`/clients/${c.id}`} className="font-medium underline-offset-2 hover:underline">
                          {c.name}
                        </Link>
                        {c.legalName && c.legalName !== c.name && <div className="text-xs text-muted-foreground">{c.legalName}</div>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{c.whatsappGroupName ?? 'No group'}</TableCell>
                      <TableCell className="text-muted-foreground">{c.dealStage ?? 'Not set'}</TableCell>
                      <TableCell className={`text-right tabular-nums ${scoreClass(c.serviceScore)}`}>{formatScore(c.serviceScore)}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.openTickets}</TableCell>
                      <TableCell>
                        <AssignSelect
                          clientId={c.id}
                          clientName={c.name}
                          vaId={c.vaId}
                          options={data.vas.map((v) => ({ id: v.id, name: v.name }))}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </div>
      )}
    </div>
  )
}
