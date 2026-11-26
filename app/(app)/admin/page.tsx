import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SlaBadge } from '@/components/accountant/ui'
import { EmptyState, LoadError, PageHeader, Section, Stat, Subnav, adminSubnav } from '@/components/admin/states'
import { formatAgo, formatDateTime, formatMinutes, formatScore, isStale, scoreClass } from '@/components/admin/format'
import { teamKpis } from '@/components/admin/kpis'
import { AccountantCard } from '@/components/team/accountant-card'
import { assignedOpenTickets } from '@/components/team/logic'
import { requireUser } from '@/lib/auth/session'
import type { AppUser } from '@/lib/auth/types'
import { getTeamOverview, listClients } from '@/lib/data'
import { cn } from '@/lib/utils'

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

      {!team.ok ? <LoadError what="the team overview" /> : <TeamBody team={team} isAdmin={isAdmin} now={now} />}

      <div className="mt-6">
        <Section title="HubSpot sync" description="Paid VA deals come in from HubSpot: stage, amount paid, active or inactive. Pushing back to HubSpot stays off until it is switched on.">
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
  const teamOpen = assignedOpenTickets(overview.accountants)
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="seniors-title" className="flex flex-col gap-3">
        <div className="anim-rise flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="seniors-title" className="text-[17px] font-semibold tracking-[-0.01em]">
              Senior accountants
            </h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Counts follow the accountant each client is assigned to. The bar is each person&apos;s share of open tickets:
              red with escalations or SLA breaches, amber with clients waiting for a reply.
            </p>
          </div>
          {isAdmin && (
            <Link href="/admin/assignment" className={cn(buttonVariants({ size: 'sm' }), 'press')}>
              Change assignment
            </Link>
          )}
        </div>

        {overview.accountants.length === 0 ? (
          <EmptyState>No accountants found in the team list yet.</EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
            {overview.accountants.map((a, i) => (
              <AccountantCard key={a.vaId} a={a} index={i} teamOpenTickets={teamOpen} />
            ))}
            {overview.unassignedClients > 0 && (
              <article
                aria-label="Unassigned clients"
                className="anim-rise flex flex-col justify-between gap-3 rounded-2xl border border-dashed border-warning/50 bg-warning-soft/60 p-4"
              >
                <div className="flex flex-col">
                  <strong className="text-sm font-semibold">Unassigned</strong>
                  <span className="text-xs text-muted-foreground">No accountant yet</span>
                </div>
                <div className="flex flex-col">
                  <span className="font-mono text-[22px] leading-tight text-warning tabular-nums">{overview.unassignedClients}</span>
                  <span className="text-xs text-muted-foreground">clients</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {isAdmin ? (
                    <>
                      Assign these clients so their tickets have an owner.{' '}
                      <Link href="/admin/assignment" className="font-medium text-primary hover:text-primary-hover">
                        Assign now
                      </Link>
                    </>
                  ) : (
                    'An admin needs to assign these clients.'
                  )}
                </p>
              </article>
            )}
          </div>
        )}
      </section>

      <section aria-label="Team totals" className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <Stat label="Clients" value={k.clients} />
        <Stat
          label="Unassigned"
          value={k.unassigned}
          tone={k.unassigned > 0 ? 'warning' : 'default'}
          hint={
            k.unassigned > 0 && isAdmin ? (
              <Link className="font-medium text-primary hover:text-primary-hover" href="/admin/assignment">
                Assign now
              </Link>
            ) : undefined
          }
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
      </section>

      <p className="anim-rise rounded-xl border border-dashed bg-card/60 px-4 py-3 text-[13px] text-muted-foreground">
        Intern reply scores arrive with the communication layer.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Open escalations" description="Newest activity first.">
          {overview.escalations.length === 0 ? (
            <EmptyState>No open escalations. Good.</EmptyState>
          ) : (
            <ul className="-mx-5 divide-y divide-line-soft border-t border-line-soft">
              {overview.escalations.map((t) => (
                <li
                  key={t.id}
                  className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-[#F8F9FB]"
                >
                  <span className={cn('size-2.5 rounded-full', t.slaBreached ? 'live-red bg-destructive' : 'bg-warning')} aria-hidden />
                  <div className="flex min-w-0 flex-col gap-1">
                    <strong className="truncate text-sm font-semibold">{t.title || 'Untitled ticket'}</strong>
                    <span className="text-xs text-muted-foreground">
                      <Link href={`/clients/${t.clientId}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                        {t.clientName ?? 'Unknown client'}
                      </Link>
                      {' · '}opened {formatDateTime(t.openedAt)}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex flex-wrap justify-end gap-1">
                      {t.fault === 'us' && (
                        <Badge variant="outline" className="rounded-md">
                          Our fault
                        </Badge>
                      )}
                      {t.slaBreached && <SlaBadge />}
                    </div>
                    <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">last message {formatAgo(t.lastMessageAt, now)}</span>
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
                    <TableCell className={`text-right font-mono tabular-nums ${scoreClass(c.serviceScore)}`}>{formatScore(c.serviceScore)}</TableCell>
                    <TableCell className={`text-right font-mono tabular-nums ${scoreClass(c.moodScore)}`}>{formatScore(c.moodScore)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatMinutes(c.worstLagMinutes)}</TableCell>
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
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <span className={cn('size-2 rounded-full', late ? 'bg-warning' : 'bg-success')} aria-hidden />
      Last successful sync: <strong className="font-semibold">{formatDateTime(hubspot.value)}</strong>
      <span className={late ? 'text-warning' : 'text-muted-foreground'}>
        ({formatAgo(hubspot.value, now)}
        {late ? ', later than expected' : ''})
      </span>
    </p>
  )
}
