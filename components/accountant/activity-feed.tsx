// Timeline rows (messages, files, meetings, tickets). Used by the Home "Today" feed and the Client 360 timeline.
import Link from 'next/link'
import { CalendarDays, FileText, MessageSquare, Ticket, type LucideIcon } from 'lucide-react'
import type { ActivityItem, TimelineItem, TimelineKind } from '@/lib/data/types'
import { formatAgo, formatDateTime, safeHref } from './logic'
import { DirectionLabel, EmptyState } from './ui'

/** Anchor prefix per kind, matching the citation links from Ask AI (lib/agent/citations.ts sourceLink). */
const ANCHOR: Record<TimelineKind, string> = { message: 'message', document: 'file', meeting: 'meeting', ticket: 'ticket' }

const KIND: Record<TimelineKind, { icon: LucideIcon; label: string }> = {
  message: { icon: MessageSquare, label: 'Message' },
  document: { icon: FileText, label: 'File' },
  meeting: { icon: CalendarDays, label: 'Meeting' },
  ticket: { icon: Ticket, label: 'Ticket' },
}

export function ActivityFeed({
  items,
  now,
  showClient = true,
  emptyText = 'Nothing new in the last 24 hours.',
  anchors = false,
}: {
  items: (TimelineItem | ActivityItem)[]
  now: Date
  showClient?: boolean
  emptyText?: string
  /** Give each row an id like `message-<id>` so citation links (`/clients/<id>#message-<id>`) scroll to it. */
  anchors?: boolean
}) {
  if (items.length === 0) return <EmptyState>{emptyText}</EmptyState>
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item) => {
        const { icon: Icon, label } = KIND[item.kind]
        const clientName = 'clientName' in item ? item.clientName : null
        return (
          <li
            key={`${item.kind}-${item.id}-${item.at}`}
            id={anchors ? `${ANCHOR[item.kind]}-${item.id}` : undefined}
            className="flex scroll-mt-24 gap-3 target:rounded-md target:bg-primary/5"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary" title={label}>
              <Icon className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="sr-only">{label}</span>
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {showClient && clientName && (
                  <Link href={`/clients/${item.clientId}`} className="font-medium text-foreground hover:underline">
                    {clientName}
                  </Link>
                )}
                <span>{label}</span>
                {item.direction && <DirectionLabel direction={item.direction} />}
                <time dateTime={item.at} title={formatDateTime(item.at)}>
                  {formatAgo(item.at, now)}
                </time>
              </div>
              <p className="text-sm font-medium break-words">
                {safeHref(item.link) ? (
                  <a href={safeHref(item.link)!} target="_blank" rel="noopener noreferrer" className="hover:underline">
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
              </p>
              {item.detail && <p className="line-clamp-3 text-sm break-words whitespace-pre-line text-muted-foreground">{item.detail}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
