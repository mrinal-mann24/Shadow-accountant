// Tickets grouped by client for the Tickets page. Each row is a link that selects the ticket (?t=) so the
// reply timeline opens beside the list. Server component.
import Link from 'next/link'
import { formatDateTime, formatMinutes, ticketWaitMinutes } from '@/components/accountant/logic'
import { EmptyState, TagBadge } from '@/components/accountant/ui'
import type { ConversationItem } from '@/lib/data/types'
import { cn } from '@/lib/utils'
import {
  shortAge,
  ticketClosedLabel,
  ticketHref,
  ticketTitle,
  ticketUrgency,
  type ClientTicketGroup,
  type TicketParams,
} from './logic'
import { AgeText, StatusDot } from './ticket-row-parts'

function metaLine(t: ConversationItem, now: Date): string {
  const msgs = `${t.messageCount} ${t.messageCount === 1 ? 'message' : 'messages'}`
  if (t.status !== 'open') return `${ticketClosedLabel(t)} ${formatDateTime(t.closedAt ?? t.lastMessageAt)} · ${msgs}`
  const wait = ticketWaitMinutes(t, now)
  const lead = t.slaBreached
    ? wait !== null
      ? `SLA breached, client waiting ${formatMinutes(wait)}`
      : 'SLA breached'
    : wait !== null
      ? `Client waiting ${formatMinutes(wait)}`
      : 'Our team replied last'
  return `${lead} · ${msgs}`
}

export function TicketGroups({
  groups,
  now,
  params,
  selectedId,
  vaNames,
  countLabel,
  emptyText,
}: {
  groups: ClientTicketGroup[]
  now: Date
  params: TicketParams
  selectedId: string | null
  /** va_id to name; empty for accountants (every ticket is theirs). */
  vaNames: Map<string, string>
  /** "open", "closed" or "tickets", shown in each count pill. */
  countLabel: string
  emptyText: string
}) {
  if (groups.length === 0) return <EmptyState>{emptyText}</EmptyState>
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g, i) => {
        const vas = g.vaIds.map((id) => vaNames.get(id)).filter((n): n is string => !!n)
        const headingId = `client-${g.clientId}`
        return (
          <section
            key={g.clientId}
            aria-labelledby={headingId}
            className={cn('anim-rise overflow-hidden rounded-2xl border bg-card', i < 8 && `anim-d${i + 1}`)}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-4 py-3">
              <h2 id={headingId} className="min-w-0 text-[14px] font-semibold">
                <Link href={`/clients/${g.clientId}`} className="hover:underline">
                  {g.clientName ?? 'Unknown client'}
                </Link>
              </h2>
              {vas.length > 0 && <span className="text-xs text-muted-foreground">{vas.join(' · ')}</span>}
              <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 font-mono text-xs tabular-nums">
                {g.tickets.length} {countLabel === 'tickets' && g.tickets.length === 1 ? 'ticket' : countLabel}
              </span>
            </div>
            <ul>
              {g.tickets.map((t) => {
                const urgency = ticketUrgency(t, now)
                const selected = t.id === selectedId
                return (
                  <li key={t.id} id={`ticket-${t.id}`} className="scroll-mt-20 border-b border-line-soft last:border-b-0">
                    <Link
                      href={ticketHref(params, t.id)}
                      scroll={false}
                      aria-current={selected ? 'true' : undefined}
                      className={cn(
                        'grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3 border-l-[3px] px-4 py-3 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                        selected ? 'border-l-primary bg-primary-soft/60' : 'border-l-transparent hover:bg-secondary/60',
                      )}
                    >
                      <StatusDot urgency={urgency} />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="truncate text-[13px] font-medium">{ticketTitle(t)}</span>
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <TagBadge tag={t.tag} />
                          <span className="truncate text-xs text-muted-foreground">{metaLine(t, now)}</span>
                        </span>
                      </span>
                      <AgeText urgency={urgency} title={`Last message ${formatDateTime(t.lastMessageAt)}`}>
                        <span className="sr-only">Last message </span>
                        {shortAge(t.lastMessageAt, now)}
                      </AgeText>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
