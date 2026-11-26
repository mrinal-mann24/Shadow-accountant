import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  computeHomeKpis,
  formatAgo,
  groupClientsByBucket,
  NO_BUCKET_LABEL,
  sortTicketsBySlaLag,
  ticketReadOnlyNote,
  ticketWaitMinutes,
} from '@/components/accountant/logic'
import { TicketList } from '@/components/accountant/ticket-list'
import { ActivityFeed } from '@/components/accountant/activity-feed'
import { FollowUpsDueList } from '@/components/accountant/follow-ups'
import { EmptyState, HealthValue, KpiCard, Section } from '@/components/accountant/ui'
import { countOverdue, greeting, homeNudge, istDateLine } from '@/components/home/logic'
import { requireUser } from '@/lib/auth/session'
import type { AppUser } from '@/lib/auth/types'
import { getClientBucket } from '@/lib/buckets'
import { listClients, listConversations, listDueFollowUps, listRecentActivity } from '@/lib/data'
import { groupClients, subgroupCount } from '@/lib/data/client-groups'
import type { FollowUpView } from '@/lib/followups/types'

export const metadata: Metadata = { title: 'Home' }
export const dynamic = 'force-dynamic'
// The Draft reply server action runs on this page: one AI call, 45 s timeout.
export const maxDuration = 60

/** Rows shown in the Follow-ups due card. More are loaded so the KPI can count them. */
const FOLLOW_UPS_SHOWN = 8
const FOLLOW_UPS_COUNTED = 50

/** Fails soft (null) while the follow_ups table is not there yet. */
async function loadDueFollowUps(user: AppUser): Promise<FollowUpView[] | null> {
  try {
    return await listDueFollowUps(user, { limit: FOLLOW_UPS_COUNTED })
  } catch (e) {
    console.error('[home] follow-ups load failed', e)
    return null
  }
}

/** A word in place of a number, sized to sit in a KPI card. */
function KpiWord({ children }: { children: React.ReactNode }) {
  return <span className="font-sans text-base font-normal tracking-normal text-muted-foreground">{children}</span>
}

export default async function HomePage() {
  const user = await requireUser()
  const now = new Date()
  const [clients, allClients, openTickets, activity, dueFollowUps] = await Promise.all([
    listClients(user),
    // Every status, so the "My clients" count nests subgroups exactly as the Clients page does.
    listClients(user, { status: 'all' }),
    listConversations(user, { status: 'open' }),
    listRecentActivity(user, { sinceHours: 24, limit: 40, clientOnly: true }),
    loadDueFollowUps(user),
  ])
  const buckets = new Map(await Promise.all(clients.map(async (c) => [c.id, await getClientBucket(c.id)] as const)))
  const kpis = computeHomeKpis(clients, openTickets)
  // Same rule as the Clients page: active HubSpot deals, subgroups counted inside their main group.
  const myClientGroups = groupClients(allClients).clients
  const groups = groupClientsByBucket(clients, buckets)
  const tickets = sortTicketsBySlaLag(openTickets, now)
  const firstName = user.name.split(' ')[0] || user.name

  const followUpsDue = dueFollowUps?.length ?? null
  const overdue = dueFollowUps ? countOverdue(dueFollowUps, now) : 0
  const firstWaiting = tickets.find((t) => ticketWaitMinutes(t, now) !== null)?.clientName ?? null
  const nudge = homeNudge({
    waitingClients: kpis.unanswered,
    firstWaitingClient: firstWaiting,
    slaBreached: kpis.slaBreached,
    followUpsDue,
    openTickets: kpis.openTickets,
  })

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="anim-rise flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] text-muted-foreground">{istDateLine(now)}</span>
          <h1 className="text-[30px] leading-tight font-semibold tracking-[-0.03em] md:text-[34px]">
            {user.viewingAs ? `${user.viewingAs.name}'s day` : `${greeting(now)}, ${firstName}`}
          </h1>
          <p className="text-[15px] text-muted-foreground">{nudge}</p>
        </div>
        <Button asChild className="press shrink-0">
          <Link href="/ask">
            <Sparkles aria-hidden />
            Ask Shadow
          </Link>
        </Button>
      </header>

      <section aria-label="Today in numbers" className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="My clients"
          value={myClientGroups.length}
          hint={`${subgroupCount(myClientGroups)} subgroups inside`}
          href="/clients"
          className="anim-d1"
        />
        <KpiCard label="Open tickets" value={kpis.openTickets} hint="Across your clients" href="/tickets" className="anim-d2" />
        <KpiCard
          label="SLA breached"
          value={kpis.slaBreached}
          hint="Open tickets past SLA"
          alert={kpis.slaBreached > 0}
          href="/tickets"
          className="anim-d3"
        />
        <KpiCard
          label="Unanswered"
          value={kpis.unanswered}
          hint="Clients waiting for a reply"
          alert={kpis.unanswered > 0}
          href="/tickets"
          className="anim-d4"
        />
        <KpiCard
          label="Follow-ups due"
          value={
            followUpsDue === null ? (
              <KpiWord>Not available</KpiWord>
            ) : followUpsDue >= FOLLOW_UPS_COUNTED ? (
              `${FOLLOW_UPS_COUNTED}+`
            ) : (
              followUpsDue
            )
          }
          hint={overdue > 0 ? `${overdue} overdue` : 'Due today or waiting'}
          alert={overdue > 0}
          href="#follow-ups"
          className="anim-d5"
        />
        <KpiCard
          label="Average health"
          value={kpis.avgHealth === null ? <KpiWord>Not scored</KpiWord> : <HealthValue score={kpis.avgHealth} />}
          hint="Service score, 0 to 100"
          href="/clients"
          className="anim-d6"
        />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Section
          title={`Needs you now (${tickets.length})`}
          className="anim-d3 h-fit"
          action={
            <Link href="/tickets" className="text-[13px] font-medium text-primary hover:text-primary-hover">
              All tickets
            </Link>
          }
        >
          <p className="mb-3 -mt-2 text-[13px] text-muted-foreground">Most urgent first: SLA breached, then longest client wait.</p>
          <TicketList tickets={tickets} now={now} readOnlyNote={ticketReadOnlyNote(user)} emptyText="No open tickets. Nice work." />
        </Section>

        <div className="flex min-w-0 flex-col gap-4">
          <div id="follow-ups" className="scroll-mt-6">
            <Section title="Follow-ups due" className="anim-d4">
              <p className="mb-3 -mt-2 text-[13px] text-muted-foreground">Promises our team made, documents to chase, repeat asks.</p>
              <FollowUpsDueList items={dueFollowUps?.slice(0, FOLLOW_UPS_SHOWN) ?? null} nowIso={now.toISOString()} />
              {followUpsDue !== null && followUpsDue > FOLLOW_UPS_SHOWN && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Showing the {FOLLOW_UPS_SHOWN} most urgent of {followUpsDue >= FOLLOW_UPS_COUNTED ? `${FOLLOW_UPS_COUNTED}+` : followUpsDue}.
                  Open a client to see all of its follow-ups.
                </p>
              )}
            </Section>
          </div>

          <Link
            href="/ask"
            className="anim-rise anim-d5 lift flex flex-col gap-3 rounded-2xl border border-ink bg-ink p-5 text-white hover:border-ink-line"
          >
            <span className="flex items-center gap-2">
              <Sparkles className="size-4 text-[#8EA2FF]" aria-hidden />
              <strong className="text-sm font-semibold">Ask Shadow</strong>
            </span>
            <span className="text-sm leading-relaxed text-[#D6DAE3]">
              Ask about any of your clients: what they sent, what we promised, what was said in a meeting.
            </span>
            <span className="flex h-10 items-center justify-between gap-2 rounded-[10px] border border-ink-line bg-ink-2 pr-1.5 pl-3 text-sm text-[#9AA1AF]">
              Ask about any client
              <span className="flex size-[30px] items-center justify-center rounded-lg bg-primary" aria-hidden>
                <ArrowRight className="size-3.5 text-white" />
              </span>
            </span>
            <span className="text-xs text-[#9AA1AF]">Answers cite the message, file or meeting minute they come from.</span>
          </Link>
        </div>
      </div>

      <Section
        title="Latest activity"
        className="anim-d6"
        action={
          activity.length > 0 ? (
            <span className="text-xs text-muted-foreground">Last 24 hours. Latest {formatAgo(activity[0].at, now)}.</span>
          ) : undefined
        }
      >
        <ActivityFeed items={activity} now={now} />
      </Section>

      <Section title="Clients by bucket" className="anim-d7">
        {groups.some((g) => g.label === NO_BUCKET_LABEL) && (
          <p className="mb-3 -mt-2 text-[13px] text-muted-foreground">
            Buckets are not stored yet. Every client shows under &quot;{NO_BUCKET_LABEL}&quot; until bucket storage is approved.
          </p>
        )}
        {clients.length === 0 ? (
          <EmptyState>No clients are assigned to you yet. Ask an Admin to assign clients.</EmptyState>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((g) => (
              <div key={g.label}>
                <h3 className="mb-2 text-xs font-medium text-meta">
                  {g.label} <span className="font-mono">({g.clients.length})</span>
                </h3>
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {g.clients.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/clients/${c.id}`}
                        className="lift flex items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2.5 text-sm"
                      >
                        <span className="min-w-0 truncate font-medium">{c.name}</span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                          {c.openTickets > 0 && <span className="font-mono">{c.openTickets} open</span>}
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
  )
}
