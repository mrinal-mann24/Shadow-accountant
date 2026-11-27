// Ticket rows used by Home and Client 360 (the Tickets page groups them by client, see components/tickets).
// Server component; actions are a client island.
import Link from 'next/link'
import type { ConversationItem } from '@/lib/data/types'
import { ticketAction } from '@/app/(app)/tickets/actions'
import { draftReplyAction } from '@/app/(app)/tickets/draft-action'
import { shortAge, ticketClosedLabel, ticketTitle, ticketUrgency } from '@/components/tickets/logic'
import { AgeText, SideBadge, StatusDot } from '@/components/tickets/ticket-row-parts'
import { DraftReplyButton } from './draft-reply'
import { formatAgo, formatDateTime, formatMinutes, ticketWaitMinutes } from './logic'
import { TicketActions } from './ticket-actions'
import { EmptyState, SlaBadge, StatusBadge, TagBadge } from './ui'

export function TicketList({
  tickets,
  now,
  showClient = true,
  readOnlyNote = null,
  emptyText = 'No tickets here.',
}: {
  tickets: ConversationItem[]
  now: Date
  showClient?: boolean
  readOnlyNote?: string | null
  emptyText?: string
}) {
  if (tickets.length === 0) return <EmptyState>{emptyText}</EmptyState>
  return (
    <ul className="-mx-2 flex flex-col">
      {tickets.map((t) => {
        const wait = ticketWaitMinutes(t, now)
        const urgency = ticketUrgency(t, now)
        const title = ticketTitle(t)
        return (
          <li
            key={t.id}
            id={`ticket-${t.id}`}
            className="grid scroll-mt-20 grid-cols-[10px_minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-xl border-b border-line-soft px-2 py-3 transition-colors last:border-b-0 hover:bg-secondary/50"
          >
            <span className="flex h-5 items-center">
              <StatusDot urgency={urgency} />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-medium wrap-break-word">{title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <TagBadge tag={t.tag} />
                {t.slaBreached && t.status === 'open' && <SlaBadge />}
                {t.status !== 'open' && <StatusBadge status={t.status} />}
                <SideBadge ticket={t} />
                {wait !== null && <span className="text-xs font-medium text-destructive">Client waiting {formatMinutes(wait)}</span>}
              </div>
              {t.summary && t.title && <p className="mt-1.5 line-clamp-2 text-[13px] text-muted-foreground">{t.summary}</p>}
              <p className="mt-1 text-xs text-muted-foreground">
                {showClient && t.clientName && (
                  <>
                    <Link href={`/clients/${t.clientId}`} className="font-medium text-foreground hover:underline">
                      {t.clientName}
                    </Link>
                    {' · '}
                  </>
                )}
                Last message {formatAgo(t.lastMessageAt, now)} ({formatDateTime(t.lastMessageAt)}) · {t.messageCount}{' '}
                {t.messageCount === 1 ? 'message' : 'messages'}
                {t.closedAt && (
                  <>
                    {' '}
                    · {ticketClosedLabel(t)} {formatDateTime(t.closedAt)}
                  </>
                )}
              </p>
            </div>
            <span className="pt-0.5 text-right">
              <AgeText urgency={urgency} title={`Last message ${formatDateTime(t.lastMessageAt)}`}>
                {shortAge(t.lastMessageAt, now)}
              </AgeText>
            </span>
            <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-2">
              <DraftReplyButton ticketId={t.id} title={title} action={draftReplyAction} />
              <TicketActions id={t.id} status={t.status} tag={t.tag} action={ticketAction} readOnlyNote={readOnlyNote} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
