import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ActivityFeed } from '@/components/accountant/activity-feed'
import { BucketControl } from '@/components/accountant/bucket-control'
import { FilesGrid } from '@/components/accountant/files-grid'
import { ticketReadOnlyNote, formatDate, formatDateTime, safeHref } from '@/components/accountant/logic'
import { TicketList } from '@/components/accountant/ticket-list'
import { EmptyState, HealthValue, PageHeader, ScoreTrend, Section } from '@/components/accountant/ui'
import { requireUser } from '@/lib/auth/session'
import { getClientBucket } from '@/lib/buckets'
import { getClient, getScoreHistory, getTimeline, listConversations, listDocuments, listMeetings } from '@/lib/data'

export const metadata: Metadata = { title: 'Client' }
export const dynamic = 'force-dynamic'
// The Draft reply server action runs on this page: one AI call, 45 s timeout.
export const maxDuration = 60

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const { id } = await params
  const client = await getClient(user, id)
  if (!client) notFound()

  const [history, tickets, documents, meetings, timeline, bucket] = await Promise.all([
    getScoreHistory(user, id, 30),
    listConversations(user, { clientId: id }),
    listDocuments(user, id),
    listMeetings(user, id),
    getTimeline(user, id, { limit: 100 }),
    getClientBucket(id),
  ])
  const now = new Date()
  const openTickets = tickets.filter((t) => t.status === 'open')
  const closedTickets = tickets.filter((t) => t.status !== 'open')
  const readOnlyNote = ticketReadOnlyNote(user)

  const profile: [string, string | null][] = [
    ['Legal name', client.legalName],
    ['Entity type', client.entityType],
    ['Industry', client.industry],
    ['City', [client.city, client.state].filter(Boolean).join(', ') || null],
    ['GSTIN', client.gstin],
    ['Email', client.email],
    ['WhatsApp group', client.whatsappGroupName],
    ['Onboarded', client.onboardingDate ? formatDate(client.onboardingDate) : null],
    ['Status', client.status],
    ['Deal stage', client.dealStage],
  ]

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/clients" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        All clients
      </Link>
      <PageHeader
        title={client.name}
        description={
          <>
            Accountant: <span className="text-foreground">{client.vaName ?? 'Unassigned'}</span>
            {' · '}
            {openTickets.length} open {openTickets.length === 1 ? 'ticket' : 'tickets'}
          </>
        }
        action={
          <Button asChild>
            <Link href={`/ask?client=${encodeURIComponent(client.id)}`}>
              <Sparkles aria-hidden />
              Ask AI about this client
            </Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Section title="Health">
            {client.serviceScore === null ? (
              <EmptyState>Not scored yet. Scores appear after the daily health score run.</EmptyState>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-8">
                  <div>
                    <p className="text-xs text-muted-foreground">Service</p>
                    <HealthValue score={client.serviceScore} delta={client.serviceDelta} className="text-2xl" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Mood</p>
                    <HealthValue score={client.moodScore} delta={client.moodDelta} className="text-2xl" />
                  </div>
                  <ScoreTrend service={history.map((h) => h.serviceScore)} mood={history.map((h) => h.moodScore)} />
                </div>
                {client.topReasons.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">Top reasons</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-sm">
                      {client.topReasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {client.scoreComputedAt && (
                  <p className="text-xs text-muted-foreground">Last scored {formatDateTime(client.scoreComputedAt)}.</p>
                )}
              </div>
            )}
          </Section>

          <Section title={`Open tickets (${openTickets.length})`}>
            <TicketList tickets={openTickets} now={now} showClient={false} readOnlyNote={readOnlyNote} emptyText="No open tickets." />
          </Section>

          {closedTickets.length > 0 && (
            <Section title={`Closed tickets (${closedTickets.length})`}>
              <TicketList tickets={closedTickets.slice(0, 10)} now={now} showClient={false} readOnlyNote={readOnlyNote} />
              {closedTickets.length > 10 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Showing the latest 10.{' '}
                  <Link href="/tickets?status=closed" className="underline">
                    See all closed tickets
                  </Link>
                </p>
              )}
            </Section>
          )}

          <Section title="Files received">
            <FilesGrid documents={documents} now={now} />
          </Section>

          <Section title="Timeline">
            <ActivityFeed items={timeline} now={now} showClient={false} anchors emptyText="No messages, files, meetings or tickets yet." />
            {timeline.length >= 100 && <p className="mt-3 text-xs text-muted-foreground">Showing the latest 100 items.</p>}
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Section title="Profile">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              {profile.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="wrap-break-word">{value || <span className="text-muted-foreground">Not set</span>}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="Bucket">
            <BucketControl bucket={bucket} />
          </Section>

          <Section title={`Contacts (${client.contacts.length})`}>
            {client.contacts.length === 0 ? (
              <EmptyState>No contacts saved.</EmptyState>
            ) : (
              <ul className="divide-y text-sm">
                {client.contacts.map((c) => (
                  <li key={c.id} className="py-2 first:pt-0 last:pb-0">
                    <p className="font-medium">
                      {c.name ?? 'Unnamed'}
                      {c.isPrimary && <span className="ml-2 text-xs font-normal text-muted-foreground">Primary</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[c.role, c.whatsappNumber].filter(Boolean).join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Meetings (${meetings.length})`}>
            {meetings.length === 0 ? (
              <EmptyState>No meetings recorded.</EmptyState>
            ) : (
              <ul className="divide-y text-sm">
                {meetings.slice(0, 10).map((m) => {
                  const href = safeHref(m.link)
                  return (
                    <li key={m.id} className="py-2 first:pt-0 last:pb-0">
                      <p className="font-medium wrap-break-word">
                        {href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {m.subject ?? 'Meeting'}
                          </a>
                        ) : (
                          (m.subject ?? 'Meeting')
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[
                          formatDateTime(m.start ?? m.date),
                          m.durationMinutes ? `${m.durationMinutes} min` : null,
                          m.pocName,
                          m.hasTranscript ? 'Transcript available' : 'No transcript',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
