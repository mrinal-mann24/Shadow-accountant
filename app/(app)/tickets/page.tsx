import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ticketReadOnlyNote, filterTickets, sortTicketsBySlaLag } from '@/components/accountant/logic'
import { isTag, TAG_LABELS } from '@/components/accountant/ticket-intent'
import { PageHeader } from '@/components/accountant/ui'
import { countOpenTicketTags, groupTicketsByClient } from '@/components/tickets/logic'
import { ReplyTimeline, ReplyTimelineMessage, TICKET_PANEL_ID } from '@/components/tickets/reply-timeline'
import { ScrollIntoViewOnPhone } from '@/components/tickets/scroll-on-phone'
import { TicketGroups } from '@/components/tickets/ticket-groups'
import { TicketTypeStrip } from '@/components/tickets/type-strip'
import { requireUser } from '@/lib/auth/session'
import type { AppUser } from '@/lib/auth/types'
import { TAGS } from '@/lib/council/types'
import { ForbiddenError, listConversations, listVas } from '@/lib/data'
import { getReplyContext, type ReplyContext } from '@/lib/data/reply-context'

export const metadata: Metadata = { title: 'Tickets' }
export const dynamic = 'force-dynamic'
// The Draft reply server action runs on this page: one AI call, 45 s timeout.
export const maxDuration = 60

type Params = { status?: string | string[]; tag?: string | string[]; q?: string | string[]; t?: string | string[] }
const STATUSES = { open: 'Open', closed: 'Closed', all: 'All' } as const
type StatusFilter = keyof typeof STATUSES

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

type Panel = { kind: 'ticket'; ctx: ReplyContext } | { kind: 'message'; title: string; text: string }

/** The selected ticket and its messages, read through lib/data (scoped to the user). Never throws. */
async function loadPanel(user: AppUser, id: string | null, now: Date): Promise<Panel> {
  if (!id) return { kind: 'message', title: 'Reply timeline', text: 'Pick a ticket to see its messages in time order.' }
  try {
    const ctx = await getReplyContext(user, id, now)
    if (!ctx) return { kind: 'message', title: 'Ticket not found', text: 'This ticket does not exist or was removed.' }
    return { kind: 'ticket', ctx }
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return { kind: 'message', title: 'Ticket not found', text: 'This ticket does not exist or was removed.' }
    }
    console.error('tickets: reply timeline failed', e)
    return { kind: 'message', title: 'Could not load messages', text: 'Please refresh the page to try again.' }
  }
}

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireUser()
  const sp = await searchParams
  const rawStatus = first(sp.status)
  const status: StatusFilter = rawStatus === 'closed' || rawStatus === 'all' ? rawStatus : 'open'
  const rawTag = first(sp.tag)
  const tag = isTag(rawTag) ? rawTag : undefined
  const q = first(sp.q)?.trim().slice(0, 100) ?? ''
  const pickedId = first(sp.t)?.trim().slice(0, 100) || null

  const now = new Date()
  const plainOpen = status === 'open' && !tag
  // The type strip always counts all open tickets; reuse the list when it is exactly that.
  const [rows, openForCounts, vas] = await Promise.all([
    listConversations(user, { status: status === 'all' ? undefined : status, tag }),
    plainOpen ? null : listConversations(user, { status: 'open' }),
    listVas(user),
  ])
  const filtered = filterTickets(rows, q)
  const tickets = status === 'open' ? sortTicketsBySlaLag(filtered, now) : filtered
  const groups = groupTicketsByClient(tickets)
  const typeCounts = countOpenTicketTags(openForCounts ?? rows)
  const filtersOn = status !== 'open' || tag || q
  const vaNames = new Map(vas.map((v) => [v.id, v.name]))

  // Selected ticket: from ?t=, else the first row so the panel is never empty when there are tickets.
  const selectedId = pickedId ?? groups[0]?.tickets[0]?.id ?? null
  const panel = await loadPanel(user, selectedId, now)

  const noun = tickets.length === 1 ? 'ticket' : 'tickets'
  const statusWord = status === 'all' ? '' : `${STATUSES[status].toLowerCase()} `
  const customers = `${groups.length} ${groups.length === 1 ? 'customer' : 'customers'}`
  const description =
    tickets.length === 0
      ? `0 ${statusWord}tickets`
      : `${tickets.length} ${statusWord}${noun} across ${customers}${
          status === 'open'
            ? '. Grouped by customer so one busy client does not hide the rest, most urgent ticket first in each.'
            : ', latest activity first.'
        }`

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Tickets" description={description} />

      <TicketTypeStrip counts={typeCounts.counts} untagged={typeCounts.untagged} activeTag={tag} q={q} />

      <form
        action="/tickets"
        role="search"
        aria-label="Filter tickets"
        className="anim-rise anim-d2 mb-4 flex flex-col gap-2 rounded-2xl border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="status" className="text-xs text-muted-foreground">
            Status
          </label>
          <select id="status" name="status" defaultValue={status} className="h-9 rounded-lg border border-input bg-card px-2 text-sm">
            {(Object.keys(STATUSES) as StatusFilter[]).map((s) => (
              <option key={s} value={s}>
                {STATUSES[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="tag" className="text-xs text-muted-foreground">
            Tag
          </label>
          <select id="tag" name="tag" defaultValue={tag ?? ''} className="h-9 rounded-lg border border-input bg-card px-2 text-sm">
            <option value="">Any tag</option>
            {TAGS.map((t) => (
              <option key={t} value={t}>
                {TAG_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="q" className="text-xs text-muted-foreground">
            Search
          </label>
          <Input id="q" name="q" defaultValue={q} placeholder="Title, summary or client" className="rounded-lg" />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="outline" className="press rounded-lg">
            Apply
          </Button>
          {filtersOn && (
            <Button asChild variant="ghost" className="rounded-lg">
              <Link href="/tickets">Reset</Link>
            </Button>
          )}
        </div>
      </form>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,1fr)]">
        <section id="tickets-list" aria-label="Tickets by customer" className="min-w-0 scroll-mt-20">
          <TicketGroups
            groups={groups}
            now={now}
            params={{ status, tag, q }}
            selectedId={selectedId}
            vaNames={vaNames}
            countLabel={status === 'all' ? 'tickets' : STATUSES[status].toLowerCase()}
            emptyText={filtersOn ? 'No tickets match these filters.' : 'No open tickets. Nice work.'}
          />
        </section>

        {panel.kind === 'ticket' ? (
          <ReplyTimeline
            ctx={panel.ctx}
            now={now}
            vaName={panel.ctx.ticket.vaId ? (vaNames.get(panel.ctx.ticket.vaId) ?? null) : null}
            readOnlyNote={ticketReadOnlyNote(user)}
          />
        ) : (
          (tickets.length > 0 || pickedId) && <ReplyTimelineMessage title={panel.title}>{panel.text}</ReplyTimelineMessage>
        )}
        {selectedId && <ScrollIntoViewOnPhone targetId={TICKET_PANEL_ID} ticketId={selectedId} active={pickedId !== null} />}
      </div>
    </div>
  )
}
