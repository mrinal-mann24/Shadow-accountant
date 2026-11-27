import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ticketReadOnlyNote, filterTickets, sortTicketsBySlaLag } from '@/components/accountant/logic'
import { isTag, TAG_LABELS } from '@/components/accountant/ticket-intent'
import { PageHeader } from '@/components/accountant/ui'
import {
  countBySide,
  countOpenTicketTags,
  DEFAULT_SIDE,
  groupTicketsByClient,
  isWaitingSide,
  WAITING_SIDE_LABELS,
  WAITING_SIDES,
  waitingSide,
  type WaitingSide,
} from '@/components/tickets/logic'
import { ReplyTimeline, ReplyTimelineMessage, TICKET_PANEL_ID } from '@/components/tickets/reply-timeline'
import { ScrollIntoViewOnPhone } from '@/components/tickets/scroll-on-phone'
import { TicketGroups } from '@/components/tickets/ticket-groups'
import { TicketTypeStrip } from '@/components/tickets/type-strip'
import { requireUser } from '@/lib/auth/session'
import type { AppUser } from '@/lib/auth/types'
import { TAGS } from '@/lib/council/types'
import { ForbiddenError, listConversations, listVas } from '@/lib/data'
import { getReplyContext, type ReplyContext } from '@/lib/data/reply-context'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Tickets' }
export const dynamic = 'force-dynamic'
// The Draft reply server action runs on this page: one AI call, 45 s timeout.
export const maxDuration = 60

type Params = {
  status?: string | string[]
  tag?: string | string[]
  q?: string | string[]
  t?: string | string[]
  side?: string | string[]
}
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
  const rawSide = first(sp.side)
  // Open tickets are split by whose turn it is; closed and all show every ticket.
  const side: WaitingSide | undefined = status === 'open' ? (isWaitingSide(rawSide) ? rawSide : DEFAULT_SIDE) : undefined

  const now = new Date()
  const plainOpen = status === 'open' && !tag
  // The type strip always counts all open tickets; reuse the list when it is exactly that.
  const [rows, openForCounts, vas] = await Promise.all([
    listConversations(user, { status: status === 'all' ? undefined : status, tag }),
    plainOpen ? null : listConversations(user, { status: 'open' }),
    listVas(user),
  ])
  const filtered = filterTickets(rows, q)
  // Tab counts follow the tag and search filters, so each tab's number matches what it shows.
  const sideCounts = side ? countBySide(filtered) : null
  const onSide = side ? filtered.filter((t) => waitingSide(t) === side) : filtered
  const tickets = status === 'open' ? sortTicketsBySlaLag(onSide, now) : onSide
  const groups = groupTicketsByClient(tickets)
  const typeCounts = countOpenTicketTags(openForCounts ?? rows)
  const filtersOn = status !== 'open' || tag || q
  const vaNames = new Map(vas.map((v) => [v.id, v.name]))

  // Selected ticket: from ?t=, else the first row so the panel is never empty when there are tickets.
  const selectedId = pickedId ?? groups[0]?.tickets[0]?.id ?? null
  const panel = await loadPanel(user, selectedId, now)

  const noun = tickets.length === 1 ? 'ticket' : 'tickets'
  const statusWord = status === 'all' ? '' : `${STATUSES[status].toLowerCase()} `
  const sideWords = side ? ` ${WAITING_SIDE_LABELS[side].toLowerCase()}` : ''
  const customers = `${groups.length} ${groups.length === 1 ? 'customer' : 'customers'}`
  const description =
    tickets.length === 0
      ? `0 ${statusWord}tickets${sideWords}`
      : `${tickets.length} ${statusWord}${noun}${sideWords} across ${customers}${
          status === 'open'
            ? '. Grouped by customer so one busy client does not hide the rest, most urgent ticket first in each.'
            : ', latest activity first.'
        }`
  const sideHref = (s: WaitingSide) => {
    const p = new URLSearchParams()
    if (s !== DEFAULT_SIDE) p.set('side', s)
    if (tag) p.set('tag', tag)
    if (q) p.set('q', q)
    const str = p.toString()
    return str ? `/tickets?${str}` : '/tickets'
  }
  const emptyText = filtersOn
    ? 'No tickets match these filters.'
    : side === 'client'
      ? 'Nothing is waiting on a client right now.'
      : 'No open tickets waiting on us. Nice work.'

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Tickets" description={description} />

      <TicketTypeStrip counts={typeCounts.counts} untagged={typeCounts.untagged} activeTag={tag} q={q} side={side} />

      {sideCounts && (
        <nav aria-label="Whose turn" className="anim-rise anim-d2 mb-4 flex flex-wrap gap-2">
          {WAITING_SIDES.map((s) => {
            const active = s === side
            return (
              <Link
                key={s}
                href={sideHref(s)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'press inline-flex items-center gap-2 rounded-xl border bg-card px-3.5 py-2 text-sm font-medium transition-colors',
                  active ? 'border-primary text-foreground ring-2 ring-primary/20' : 'text-muted-foreground hover:bg-secondary/60',
                )}
              >
                <span
                  aria-hidden
                  className={cn('size-2 rounded-full', s === 'client' ? 'bg-destructive' : 'bg-primary')}
                />
                {WAITING_SIDE_LABELS[s]}
                <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs tabular-nums">{sideCounts[s]}</span>
              </Link>
            )
          })}
          <p className="w-full text-xs text-muted-foreground sm:ml-1 sm:w-auto sm:self-center">
            {side === 'client'
              ? 'We asked the client and are waiting for their reply. These do not count against the team.'
              : 'The client is waiting on our team, or we replied and the work is still ours.'}
          </p>
        </nav>
      )}

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
            params={{ status, tag, q, side }}
            selectedId={selectedId}
            vaNames={vaNames}
            countLabel={status === 'all' ? 'tickets' : STATUSES[status].toLowerCase()}
            emptyText={emptyText}
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
