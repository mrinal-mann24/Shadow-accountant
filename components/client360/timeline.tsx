// Client 360 timeline: messages, files, meetings and tickets for one client as one feed, coloured by channel.
// Rows keep the `message-<id>` / `file-<id>` / `meeting-<id>` / `ticket-<id>` anchors that Ask Shadow citation
// links scroll to (lib/agent/citations.ts sourceLink). Group chips link to the parent and sub-group pages, because
// each WhatsApp group is its own client with its own timeline. No hooks: a server component.
import Link from 'next/link'
import { CalendarDays, FileText, MessageCircle, Ticket, type LucideIcon } from 'lucide-react'
import { formatAgo, formatDateTime, safeHref } from '@/components/accountant/logic'
import { DirectionLabel } from '@/components/accountant/ui'
import type { TimelineItem, TimelineKind } from '@/lib/data/types'
import { cn } from '@/lib/utils'

const ANCHOR: Record<TimelineKind, string> = { message: 'message', document: 'file', meeting: 'meeting', ticket: 'ticket' }

const CHANNEL: Record<TimelineKind, { icon: LucideIcon; label: string; tone: string }> = {
  message: { icon: MessageCircle, label: 'WhatsApp', tone: 'bg-whatsapp-soft text-whatsapp' },
  document: { icon: FileText, label: 'File', tone: 'bg-drive-soft text-drive' },
  meeting: { icon: CalendarDays, label: 'Meeting', tone: 'bg-teal-soft text-teal' },
  ticket: { icon: Ticket, label: 'Ticket', tone: 'bg-success-soft text-success' },
}

export type GroupChip = { id: string; label: string; current: boolean }

export function TimelineCard({
  items,
  now,
  groupLabel,
  groups,
  limit,
}: {
  items: TimelineItem[]
  now: Date
  /** This client's WhatsApp group, shown on message rows. */
  groupLabel: string | null
  /** This group plus its parent and sub-groups the user can see. Chips show only when there is more than one. */
  groups: GroupChip[]
  limit: number
}) {
  return (
    <section
      aria-labelledby="timeline-title"
      className="anim-rise anim-d2 flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
    >
      <div className="flex flex-col gap-3 border-b border-line-soft px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="timeline-title" className="text-[17px] font-semibold tracking-[-0.01em]">
            Timeline
          </h2>
          <span className="text-xs text-muted-foreground">WhatsApp, files, meetings and tickets in one place</span>
        </div>
        {groups.length > 1 && (
          <nav aria-label="WhatsApp groups" className="flex flex-wrap gap-1.5">
            {groups.map((g) =>
              g.current ? (
                <span
                  key={g.id}
                  aria-current="page"
                  className="inline-flex h-8 max-w-full items-center truncate rounded-full border border-ink bg-ink px-3 text-[13px] text-white"
                >
                  {g.label}
                </span>
              ) : (
                <Link
                  key={g.id}
                  href={`/clients/${encodeURIComponent(g.id)}`}
                  className="press inline-flex h-8 max-w-full items-center truncate rounded-full border bg-card px-3 text-[13px] text-foreground hover:border-[#d5dae3] hover:bg-secondary"
                >
                  {g.label}
                </Link>
              ),
            )}
          </nav>
        )}
      </div>

      {items.length === 0 ? (
        <p className="px-5 py-7 text-sm text-muted-foreground">No messages, files, meetings or tickets yet.</p>
      ) : (
        <ol className="max-h-[70vh] min-w-0 overflow-y-auto lg:max-h-[680px]">
          {items.map((item) => {
            const { icon: Icon, label, tone } = CHANNEL[item.kind]
            const href = safeHref(item.link)
            return (
              <li
                key={`${item.kind}-${item.id}-${item.at}`}
                id={`${ANCHOR[item.kind]}-${item.id}`}
                className="grid scroll-mt-24 grid-cols-[36px_minmax(0,1fr)_auto] gap-3.5 border-b border-line-soft px-5 py-3.5 transition-colors last:border-b-0 hover:bg-[#f8f9fb] target:bg-primary-soft sm:gap-3.5"
              >
                <span className={cn('flex size-9 items-center justify-center rounded-[10px]', tone)} aria-hidden>
                  <Icon className="size-4" />
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <strong className="min-w-0 text-sm font-semibold break-words">
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-foreground hover:underline">
                          {item.title}
                        </a>
                      ) : (
                        item.title
                      )}
                    </strong>
                    <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-medium', tone)}>{label}</span>
                    {item.kind === 'message' && groupLabel && (
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{groupLabel}</span>
                    )}
                    {/* The client page feed is client-sent only, so only a team message needs saying. */}
                    {item.direction === 'outgoing' && <DirectionLabel direction={item.direction} />}
                  </div>
                  {item.detail && (
                    <p className="line-clamp-3 text-[13px] leading-relaxed break-words whitespace-pre-line text-[#374151]">
                      {item.detail}
                    </p>
                  )}
                </div>
                <time
                  dateTime={item.at}
                  title={formatDateTime(item.at)}
                  className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums"
                >
                  {formatAgo(item.at, now)}
                </time>
              </li>
            )
          })}
        </ol>
      )}
      {items.length >= limit && (
        <p className="border-t border-line-soft px-5 py-3 text-xs text-muted-foreground">Showing the latest {limit} items.</p>
      )}
    </section>
  )
}
