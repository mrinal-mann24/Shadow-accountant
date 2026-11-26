import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CalendarDays, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BucketControl } from '@/components/accountant/bucket-control'
import { FilesGrid } from '@/components/accountant/files-grid'
import { ScrollToHash } from '@/components/accountant/scroll-to-hash'
import { FollowUpsPanel } from '@/components/accountant/follow-ups'
import { ticketReadOnlyNote, formatDate, formatDateTime, safeHref } from '@/components/accountant/logic'
import { TicketList } from '@/components/accountant/ticket-list'
import { EmptyState, HealthValue, ScoreTrend, Section } from '@/components/accountant/ui'
import { ChatPanel } from '@/components/chat/chat-panel'
import { ClientHeader } from '@/components/client360/client-header'
import { businessName } from '@/components/client360/name'
import { TimelineCard, type GroupChip } from '@/components/client360/timeline'
import { requireUser } from '@/lib/auth/session'
import type { AppUser } from '@/lib/auth/types'
import { getClientBucket } from '@/lib/buckets'
import { getClient, getScoreHistory, getTimeline, listClients, listConversations, listDocuments, listFollowUps, listMeetings, parentFolderName } from '@/lib/data'
import type { ClientDetail, ClientListItem } from '@/lib/data/types'
import type { FollowUpView } from '@/lib/followups/types'
import { followUpFormAction } from './follow-up-actions'

export const metadata: Metadata = { title: 'Client' }
export const dynamic = 'force-dynamic'
// The Draft reply server action runs on this page: one AI call, 45 s timeout.
export const maxDuration = 60

const TIMELINE_LIMIT = 100

/** Open follow-ups plus recent closed ones. Fails soft (null) while the follow_ups table is not there yet. */
async function loadFollowUps(user: AppUser, clientId: string): Promise<FollowUpView[] | null> {
  try {
    // Every open item, plus the latest rows of any status for "Recently closed" (the panel keeps 10 closed ones).
    const [open, recent] = await Promise.all([
      listFollowUps(user, clientId, { status: 'open', limit: 500 }),
      listFollowUps(user, clientId, { status: 'all', limit: 100 }),
    ])
    const openIds = new Set(open.map((f) => f.id))
    return [...open, ...recent.filter((f) => !openIds.has(f.id))]
  } catch (e) {
    console.error('[client] follow-ups load failed', e)
    return null
  }
}

/**
 * The WhatsApp groups around this client that the user can see: the main group first, then its sub-groups.
 * Each group is its own client (clients.parent_client_id), so the chips link to the group's own page.
 */
function groupFamily(client: ClientDetail, visible: ClientListItem[]) {
  const rootId = client.parentClientId ?? client.id
  const root = rootId === client.id ? client : (visible.find((c) => c.id === rootId) ?? null)
  const children = visible.filter((c) => c.parentClientId === rootId).sort((a, b) => a.name.localeCompare(b.name))
  const chips: GroupChip[] = []
  if (root) chips.push({ id: root.id, label: 'Main group', current: root.id === client.id })
  for (const c of children) {
    chips.push({ id: c.id, label: businessName(c.whatsappGroupName, c.name), current: c.id === client.id })
  }
  if (!chips.some((g) => g.current)) chips.push({ id: client.id, label: businessName(client.whatsappGroupName, client.name), current: true })
  return {
    chips,
    count: root ? 1 + children.length : 0,
    parent: client.parentClientId && root ? { id: root.id, name: businessName(root.whatsappGroupName, root.name) } : null,
  }
}

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireUser()
  const { id } = await params
  // ?file=<upload id> from a Teams "View" link: list and highlight that file.
  const focusFile = (await searchParams).file
  const focusFileId = typeof focusFile === 'string' && focusFile.length <= 100 ? focusFile : null
  const client = await getClient(user, id)
  if (!client) notFound()

  const [history, tickets, documents, meetings, timeline, bucket, followUps, parent, visibleClients] = await Promise.all([
    getScoreHistory(user, id, 30),
    listConversations(user, { clientId: id }),
    listDocuments(user, id, { clientOnly: true }),
    listMeetings(user, id),
    getTimeline(user, id, { limit: TIMELINE_LIMIT, clientOnly: true }),
    getClientBucket(id),
    loadFollowUps(user, id),
    // A sub-group's files sit inside its parent's folder; only the folder name is read, whoever the parent's accountant is.
    client.parentClientId ? parentFolderName(user, client.id).catch(() => null) : Promise.resolve(null),
    // Only for the group chips: the parent and sub-groups this user can see. Fails soft to no chips.
    listClients(user, { status: 'all' }).catch((e: unknown) => {
      console.error('[client] group list load failed', e)
      return [] as ClientListItem[]
    }),
  ])
  const parentFolder = parent
  const now = new Date()
  const openTickets = tickets.filter((t) => t.status === 'open')
  const closedTickets = tickets.filter((t) => t.status !== 'open')
  const readOnlyNote = ticketReadOnlyNote(user)
  const name = businessName(client.whatsappGroupName, client.name)
  const dealName = client.name.trim().toLowerCase() !== name.toLowerCase() ? client.name : null
  const family = groupFamily(client, visibleClients)

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
    <div className="mx-auto flex max-w-[1240px] min-w-0 flex-col gap-5">
      <ScrollToHash />
      <nav aria-label="Breadcrumb" className="anim-rise flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
        <Link href="/clients" className="text-primary hover:text-primary-hover">
          Clients
        </Link>
        <span aria-hidden>/</span>
        <span aria-current="page" className="min-w-0 truncate">
          {name}
        </span>
      </nav>

      <ClientHeader
        name={name}
        dealName={dealName}
        dealStage={client.dealStage}
        accountant={client.vaName}
        groupCount={family.count}
        parent={family.parent}
        score={client.serviceScore}
        reason={client.topReasons[0] ?? null}
        openTickets={openTickets.length}
        unanswered={client.unansweredCount}
        action={
          <Button asChild className="press h-[42px] rounded-xl px-4 shadow-[0_8px_20px_-10px_rgba(49,77,208,0.7)]">
            <Link href={`/ask?client=${encodeURIComponent(client.id)}`}>
              <Sparkles aria-hidden />
              Ask Shadow about this client
            </Link>
          </Button>
        }
      />

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
        <TimelineCard items={timeline} now={now} groupLabel={name} groups={family.chips} limit={TIMELINE_LIMIT} />
        <ChatPanel fixedClient={{ id: client.id, name }} />
      </div>

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title={`Open tickets (${openTickets.length})`}>
            <TicketList tickets={openTickets} now={now} showClient={false} readOnlyNote={readOnlyNote} emptyText="No open tickets." />
          </Section>

          <div id="follow-ups" className="scroll-mt-20">
            <Section title="Follow-ups">
              <FollowUpsPanel
                items={followUps}
                nowIso={now.toISOString()}
                action={followUpFormAction}
                user={{ role: user.role, viewingAs: Boolean(user.viewingAs) }}
              />
            </Section>
          </div>

          {closedTickets.length > 0 && (
            <Section title={`Closed tickets (${closedTickets.length})`}>
              <TicketList tickets={closedTickets.slice(0, 10)} now={now} showClient={false} readOnlyNote={readOnlyNote} />
              {closedTickets.length > 10 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Showing the latest 10.{' '}
                  <Link href="/tickets?status=closed" className="text-primary hover:text-primary-hover">
                    See all closed tickets
                  </Link>
                </p>
              )}
            </Section>
          )}

          <div id="files" className="scroll-mt-20">
            <Section title="Files received">
              <FilesGrid
                documents={documents}
                now={now}
                focusId={focusFileId}
                neo={{ clientId: client.id, clientName: client.name, companyName: client.legalName?.trim() || client.name, parentFolder }}
              />
            </Section>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Health">
            {client.serviceScore === null ? (
              <EmptyState>Not scored yet. Scores appear after the daily health score run.</EmptyState>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-8">
                  <div>
                    <p className="text-xs text-muted-foreground">Service</p>
                    <HealthValue score={client.serviceScore} delta={client.serviceDelta} className="font-mono text-2xl" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Mood</p>
                    <HealthValue score={client.moodScore} delta={client.moodDelta} className="font-mono text-2xl" />
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

          <Section title="Profile">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              {profile.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="wrap-break-word">{value || <span className="text-meta">Not set</span>}</dd>
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
              <ul className="divide-y divide-line-soft text-sm">
                {client.contacts.map((c) => (
                  <li key={c.id} className="py-2.5 first:pt-0 last:pb-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {c.name ?? 'Unnamed'}
                      {c.isPrimary && (
                        <span className="rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">Primary</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{[c.role, c.whatsappNumber].filter(Boolean).join(' · ')}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Meetings (${meetings.length})`}>
            {meetings.length === 0 ? (
              <EmptyState>No meetings recorded.</EmptyState>
            ) : (
              <ul className="divide-y divide-line-soft text-sm">
                {meetings.slice(0, 10).map((m) => {
                  const href = safeHref(m.link)
                  return (
                    <li key={m.id} className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-teal-soft text-teal" aria-hidden>
                        <CalendarDays className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium wrap-break-word">
                          {href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="text-foreground hover:underline">
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
                      </div>
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
