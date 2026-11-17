// Ticket rows used by Home, Tickets and Client 360. Server component; actions are a client island.
import Link from 'next/link'
import type { ConversationItem } from '@/lib/data/types'
import { ticketAction } from '@/app/(app)/tickets/actions'
import { draftReplyAction } from '@/app/(app)/tickets/draft-action'
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
    <ul className="divide-y">
      {tickets.map((t) => {
        const wait = ticketWaitMinutes(t, now)
        return (
          <li key={t.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <TagBadge tag={t.tag} />
              {t.slaBreached && t.status === 'open' && <SlaBadge />}
              <StatusBadge status={t.status} />
              {wait !== null && (
                <span className="text-xs font-medium text-destructive">Client waiting {formatMinutes(wait)}</span>
              )}
            </div>
            <div className="min-w-0">
              <p className="font-medium wrap-break-word">{t.title ?? (t.summary.slice(0, 80) || 'Untitled ticket')}</p>
              {t.summary && t.title && <p className="line-clamp-2 text-sm text-muted-foreground">{t.summary}</p>}
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
                {t.closedAt && <> · Closed {formatDateTime(t.closedAt)}</>}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DraftReplyButton
                ticketId={t.id}
                title={t.title ?? (t.summary.slice(0, 80) || 'Untitled ticket')}
                action={draftReplyAction}
              />
              <TicketActions id={t.id} status={t.status} tag={t.tag} action={ticketAction} readOnlyNote={readOnlyNote} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
