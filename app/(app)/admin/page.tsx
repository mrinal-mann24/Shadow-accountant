import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, LoadError, PageHeader, Section, Stat, Subnav, adminSubnav } from '@/components/admin/states'
import { formatAgo, formatDateTime, formatMinutes, formatScore, isStale, scoreClass } from '@/components/admin/format'
import { teamKpis } from '@/components/admin/kpis'
import { requireUser } from '@/lib/auth/session'
import type { AppUser } from '@/lib/auth/types'
import { getTeamOverview, listClients } from '@/lib/data'

export const metadata = { title: 'Team' }

/** HubSpot sync runs every 30 minutes (vercel.json); older than this reads as late. */
const HUBSPOT_LATE_MINUTES = 60

/** hubspot_last_sync comes with the team overview (admin and engineer). */
type HubspotState = { status: 'ok'; value: string | null } | { status: 'error' }

async function loadTeam(user: AppUser) {
  try {
    const [overview, clients] = await Promise.all([getTeamOverview(user), listClients(user)])
    return { ok: true as const, overview, clients }
  } catch (e) {
    console.error('[admin] team overview failed', e)
    return { ok: false as const }
  }
}

export default async function AdminTeamPage() {
  const user = await requireUser(['admin', 'engineer'])
  const team = await loadTeam(user)
  const hubspot: HubspotState = team.ok ? { status: 'ok', value: team.overview.hubspotLastSync } : { status: 'error' }
  const now = new Date()
  const isAdmin = user.role === 'admin'

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Team" description="Workload, escalations and client health across every accountant." />
      <Subnav items={adminSubnav(user.role)} current="/admin" />

      {!team.ok ? (
        <LoadError what="the team overview" />
      ) : (
        <TeamBody team={team} isAdmin={isAdmin} now={now} />
      )}

      <div className="mt-6">
        <Section title="HubSpot sync" description="Deal stage and amount come in, accountant, health score and open tickets go out.">
          <HubspotStatus hubspot={hubspot} now={now} />
        </Section>
      </div>
    </div>
  )
}

function TeamBody({
  team,
  isAdmin,
  now,
}: {
  team: Extract<Awaited<ReturnType<typeof loadTeam>>, { ok: true }>
  isAdmin: boolean
  now: Date
}) {
  const { overview, clients } = team
  const k = teamKpis(overview, clients)
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <Stat label="Clients" value={k.clients} />
        <Stat
          label="Unassigned"
          value={k.unassigned}
          tone={k.unassigned > 0 ? 'warning' : 'default'}
          hint={k.unassigned > 0 && isAdmin ? <Link className="underline" href="/admin/assignment">Assign now</Link> : undefined}
        />
        <Stat label="Open tickets" value={k.openTickets} />
        <Stat label="Open escalations" value={k.openEscalations} tone={k.openEscalations > 0 ? 'danger' : 'default'} />
        <Stat label="SLA breaches" value={k.slaBreached} tone={k.slaBreached > 0 ? 'warning' : 'default'} hint="Open tickets past SLA" />
        <Stat label="Waiting for reply" value={k.unansweredClients} hint="Clients" />
        <Stat
          label="Average health"
          value={<span className={scoreClass(k.avgHealth)}>{formatScore(k.avgHealth)}</span>}
          hint={`${k.scoredClients} of ${k.clients} scored`}
        />
      </div>

      <Section
        title="Workload per accountant"
        description="Counts follow the accountant each client is assigned to."
        action={
          isAdmin ? (
            <Link href="/admin/assignment" className={buttonVariants({ size: 'sm' })}>
              Change assignment
            </Link>
          ) : undefined
        }
      >
        {overview.accountants.length === 0 ? (
          <EmptyState>No accountants found in the team list yet.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Accountant</TableHead>
                <TableHead className="text-right">Clients</TableHead>
                <TableHead className="text-right">Open tickets</TableHead>
                <TableHead className="text-right">Escalations</TableHead>
                <TableHead className="text-right">SLA breaches</TableHead>
                <TableHead className="text-right">Waiting for reply</TableHead>
                <TableHead className="text-right">Avg health</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.accountants.map((a) => (
                <TableRow key={a.vaId}>
                  <TableCell>
                    <div className="font-medium">{a.name}</div>
                    {a.status && a.status !== 'active' && <div className="text-xs text-muted-foreground">{a.status}</div>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{a.clientCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.openTickets}</TableCell>
                  <TableCell className={`text-right tabular-nums ${a.openEscalations > 0 ? 'text-destructive' : ''}`}>
                    {a.openEscalations}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${a.slaBreachedOpen > 0 ? 'text-warning' : ''}`}>
                    {a.slaBreachedOpen}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{a.unansweredClients}</TableCell>
                  <TableCell className={`text-right tabular-nums ${scoreClass(a.avgServiceScore)}`}>
                    {formatScore(a.avgServiceScore)}
                  </TableCell>
                </TableRow>
              ))}
              {overview.unassignedClients > 0 && (
                <TableRow>
                  <TableCell className="text-muted-foreground">Unassigned</TableCell>
                  <TableCell className="text-right tabular-nums text-warning">{overview.unassignedClients}</TableCell>
                  <TableCell colSpan={5} className="text-xs text-muted-foreground">
                    {isAdmin ? 'Assign these clients so their tickets have an owner.' : 'An admin needs to assign these clients.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Open escalations" description="Newest activity first.">
          {overview.escalations.length === 0 ? (
            <EmptyState>No open escalations. Good.</EmptyState>
          ) : (
            <ul className="divide-y">
              {overview.escalations.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{t.title || 'Untitled ticket'}</div>
                    <div className="text-xs text-muted-foreground">
                      <Link href={`/clients/${t.clientId}`} className="underline-offset-2 hover:underline">
                        {t.clientName ?? 'Unknown client'}
                      </Link>
                      {' · '}opened {formatDateTime(t.openedAt)}
                      {' · '}last message {formatAgo(t.lastMessageAt, now)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {t.fault === 'us' && <Badge variant="outline">Our fault</Badge>}
                    {t.slaBreached && <Badge variant="destructive">SLA breached</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Lowest health" description="The 10 scored clients with the lowest service score.">
          {overview.lowestHealth.length === 0 ? (
            <EmptyState>No clients have been scored yet. Scores appear after the daily health score job writes.</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Accountant</TableHead>
                  <TableHead className="text-right">Service</TableHead>
                  <TableHead className="text-right">Mood</TableHead>
                  <TableHead className="text-right">Worst wait</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.lowestHealth.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/clients/${c.id}`} className="font-medium underline-offset-2 hover:underline">
                        {c.name}
                      </Link>
                      {c.openEscalations > 0 && <div className="text-xs text-destructive">{c.openEscalations} open escalation(s)</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.vaName ?? 'Unassigned'}</TableCell>
                    <TableCell className={`text-right tabular-nums ${scoreClass(c.serviceScore)}`}>{formatScore(c.serviceScore)}</TableCell>
                    <TableCell className={`text-right tabular-nums ${scoreClass(c.moodScore)}`}>{formatScore(c.moodScore)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinutes(c.worstLagMinutes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </div>
    </div>
  )
}

function HubspotStatus({ hubspot, now }: { hubspot: HubspotState; now: Date }) {
  if (hubspot.status === 'error') return <LoadError what="the HubSpot sync status" />
  if (!hubspot.value) {
    return (
      <p className="text-sm text-muted-foreground">
        HubSpot sync has not written yet. It runs in dry-run mode until writes are switched on, so no sync time is recorded.
      </p>
    )
  }
  const late = isStale(hubspot.value, now, HUBSPOT_LATE_MINUTES)
  return (
    <p className="text-sm">
      Last successful sync: <strong>{formatDateTime(hubspot.value)}</strong>{' '}
      <span className={late ? 'text-warning' : 'text-muted-foreground'}>
        ({formatAgo(hubspot.value, now)}
        {late ? ', later than expected' : ''})
      </span>
    </p>
  )
}
