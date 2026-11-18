import type { Metadata } from 'next'
import Link from 'next/link'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { computeHomeKpis, formatAgo, groupClientsByBucket, NO_BUCKET_LABEL, sortTicketsBySlaLag, ticketReadOnlyNote } from '@/components/accountant/logic'
import { TicketList } from '@/components/accountant/ticket-list'
import { ActivityFeed } from '@/components/accountant/activity-feed'
import { FollowUpsDueList } from '@/components/accountant/follow-ups'
import { EmptyState, HealthValue, KpiCard, PageHeader, Section } from '@/components/accountant/ui'
import { requireUser } from '@/lib/auth/session'
import type { AppUser } from '@/lib/auth/types'
import { getClientBucket } from '@/lib/buckets'
import { listClients, listConversations, listDueFollowUps, listRecentActivity } from '@/lib/data'
import type { FollowUpView } from '@/lib/followups/types'

export const metadata: Metadata = { title: 'Home' }
export const dynamic = 'force-dynamic'
// The Draft reply server action runs on this page: one AI call, 45 s timeout.
export const maxDuration = 60

/** Fails soft (null) while the follow_ups table is not there yet. */
async function loadDueFollowUps(user: AppUser): Promise<FollowUpView[] | null> {
  try {
    return await listDueFollowUps(user, { limit: 8 })
  } catch (e) {
    console.error('[home] follow-ups load failed', e)
    return null
  }
}

export default async function HomePage() {
  const user = await requireUser()
  const now = new Date()
  const [clients, openTickets, activity, dueFollowUps] = await Promise.all([
    listClients(user),
    listConversations(user, { status: 'open' }),
    listRecentActivity(user, { sinceHours: 24, limit: 40, clientOnly: true }),
    loadDueFollowUps(user),
  ])
  const buckets = new Map(await Promise.all(clients.map(async (c) => [c.id, await getClientBucket(c.id)] as const)))
  const kpis = computeHomeKpis(clients, openTickets)
  const groups = groupClientsByBucket(clients, buckets)
  const tickets = sortTicketsBySlaLag(openTickets, now)
  const firstName = user.name.split(' ')[0] || user.name

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={user.viewingAs ? `${user.viewingAs.name}'s day` : `Hello, ${firstName}`}
        description="Your clients, open tickets and what happened in the last 24 hours."
        action={
          <Button asChild>
            <Link href="/ask">
              <Sparkles aria-hidden />
              Ask AI
            </Link>
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="My clients" value={kpis.myClients} />
        <KpiCard label="Open tickets" value={kpis.openTickets} />
        <KpiCard label="SLA breached" value={kpis.slaBreached} alert={kpis.slaBreached > 0} />
        <KpiCard
          label="Average health"
          value={kpis.avgHealth === null ? 'Not scored' : <HealthValue score={kpis.avgHealth} />}
          hint="Service score, 0 to 100"
        />
        <KpiCard label="Unanswered" value={kpis.unanswered} hint="Clients waiting for a reply" alert={kpis.unanswered > 0} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Section
            title={`My open tickets (${tickets.length})`}
            action={
              <Link href="/tickets" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
                All tickets
              </Link>
            }
          >
            <p className="mb-3 text-xs text-muted-foreground">Most urgent first: SLA breached, then longest client wait.</p>
            <TicketList tickets={tickets} now={now} readOnlyNote={ticketReadOnlyNote(user)} emptyText="No open tickets. Nice work." />
          </Section>

          <Section title="Clients by bucket">
            {groups.some((g) => g.label === NO_BUCKET_LABEL) && (
              <p className="mb-3 text-xs text-muted-foreground">
                Buckets are not stored yet. Every client shows under &quot;{NO_BUCKET_LABEL}&quot; until bucket storage is
                approved.
              </p>
            )}
            {clients.length === 0 ? (
              <EmptyState>No clients are assigned to you yet. Ask an Admin to assign clients.</EmptyState>
            ) : (
              <div className="flex flex-col gap-4">
                {groups.map((g) => (
                  <div key={g.label}>
                    <h3 className="mb-2 text-sm font-medium">
                      {g.label} <span className="text-muted-foreground">({g.clients.length})</span>
                    </h3>
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {g.clients.map((c) => (
                        <li key={c.id}>
                          <Link
                            href={`/clients/${c.id}`}
                            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm hover:bg-secondary"
                          >
                            <span className="min-w-0 truncate">{c.name}</span>
                            <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                              {c.openTickets > 0 && <span>{c.openTickets} open</span>}
                              <HealthValue score={c.serviceScore} delta={c.serviceDelta} className="text-sm" />
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Section title="Follow-ups due" className="h-fit">
            <FollowUpsDueList items={dueFollowUps} nowIso={now.toISOString()} />
          </Section>

          <Section title="Today" className="h-fit">
            <ActivityFeed items={activity} now={now} />
            {activity.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">Last 24 hours. Latest {formatAgo(activity[0].at, now)}.</p>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
