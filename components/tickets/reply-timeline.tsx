// Reply timeline side panel on the Tickets page: the selected ticket's messages in time order (IST), who wrote
// each one, files shared, and the ticket's actions. Server component; actions are client islands.
import { FileText } from 'lucide-react'
import Link from 'next/link'
import { ticketAction } from '@/app/(app)/tickets/actions'
import { draftReplyAction } from '@/app/(app)/tickets/draft-action'
import { DraftReplyButton } from '@/components/accountant/draft-reply'
import { formatDateTime, formatMinutes } from '@/components/accountant/logic'
import { TicketActions } from '@/components/accountant/ticket-actions'
import { SlaBadge, StatusBadge, TagBadge } from '@/components/accountant/ui'
import type { ReplyContext } from '@/lib/data/reply-context'
import { cn } from '@/lib/utils'
import { buildTimeline, firstReply, ticketClosedLabel, ticketTitle, type TimelineEvent } from './logic'
import { SideBadge } from './ticket-row-parts'

export const TICKET_PANEL_ID = 'ticket-panel'

function PanelShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <aside
      id={TICKET_PANEL_ID}
      aria-label="Reply timeline"
      className={cn(
        'anim-slide flex scroll-mt-20 flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] lg:sticky lg:top-20 lg:max-h-[calc(100svh-6rem)]',
        className,
      )}
    >
      {children}
    </aside>
  )
}

/** Panel when there is nothing to show (no ticket picked, not found, no access, or a load error). */
export function ReplyTimelineMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <PanelShell>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
      <p className="text-sm text-muted-foreground">{children}</p>
    </PanelShell>
  )
}

const DOT = {
  client: 'bg-meta shadow-[0_0_0_1px_var(--meta)]',
  team: 'bg-primary shadow-[0_0_0_1px_var(--primary)]',
  file: 'bg-success shadow-[0_0_0_1px_var(--success)]',
} as const

const WHO = {
  client: 'text-muted-foreground',
  team: 'text-accent-foreground',
  file: 'text-success',
} as const

function whoLabel(e: TimelineEvent): string {
  const side = e.who === 'team' ? 'Our team' : 'Client'
  const parts = [side]
  if (e.senderName) parts.push(e.senderName)
  if (e.file) parts.push('file')
  return parts.join(' · ')
}

export function ReplyTimeline({
  ctx,
  now,
  vaName,
  readOnlyNote,
}: {
  ctx: ReplyContext
  now: Date
  vaName: string | null
  readOnlyNote: string | null
}) {
  const t = ctx.ticket
  const title = ticketTitle(t)
  const events = buildTimeline(ctx.ticketMessages)
  const reply = firstReply(ctx.ticketMessages)
  const shown = ctx.ticketMessages.length
  const clientName = ctx.clientName ?? t.clientName ?? 'Unknown client'

  return (
    <PanelShell>
      <div className="flex shrink-0 flex-col gap-1.5">
        <p className="text-xs text-muted-foreground">
          <Link href={`/clients/${t.clientId}`} className="hover:underline">
            {clientName}
          </Link>
          {vaName && <> · {vaName}</>}
        </p>
        <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.02em] wrap-break-word">{title}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <TagBadge tag={t.tag} />
          {t.slaBreached && t.status === 'open' && <SlaBadge />}
          <StatusBadge status={t.status} />
          <SideBadge ticket={t} />
          {reply.kind === 'replied' && (
            <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
              First reply in {formatMinutes(reply.minutes)}
            </span>
          )}
          {reply.kind === 'waiting' && t.status === 'open' && (
            <span className="rounded-md bg-destructive-soft px-2 py-0.5 text-xs font-medium text-destructive">
              No reply yet, waiting {formatMinutes((now.getTime() - Date.parse(reply.since)) / 60_000)}
            </span>
          )}
        </div>
        {t.summary && (
          <p className="mt-1 line-clamp-4 text-[13px] leading-relaxed text-muted-foreground" title={t.summary}>
            {t.summary}
          </p>
        )}
        <p className="text-xs text-meta">
          Opened {formatDateTime(t.openedAt)}
          {t.closedAt && (
            <>
              {' '}
              · {ticketClosedLabel(t)} {formatDateTime(t.closedAt)}
            </>
          )}
        </p>
      </div>

      {events.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No messages are linked to this ticket yet.
        </p>
      ) : (
        <div
          className="-mx-1 px-1 lg:min-h-20 lg:flex-auto lg:overflow-y-auto"
          tabIndex={0}
          role="region"
          aria-label={`Messages on this ticket, oldest first, times in IST`}
        >
          <ol className="flex flex-col">
            {events.map((e, i) => {
              const kind = e.file ? 'file' : e.who
              const last = i === events.length - 1
              return (
                <li key={e.id}>
                  {e.day && (
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-medium tracking-wide text-meta uppercase">
                      <span>{e.day}</span>
                      <span className="h-px flex-1 bg-line-soft" aria-hidden />
                    </div>
                  )}
                  <div className="grid grid-cols-[60px_18px_minmax(0,1fr)] gap-2.5">
                    <time dateTime={e.at} className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                      {e.time}
                    </time>
                    <span className="flex flex-col items-center" aria-hidden>
                      <span className={cn('mt-[3px] size-3 rounded-full border-2 border-card', DOT[kind])} />
                      {!last && <span className="min-h-5 w-0.5 flex-1 bg-line-soft" />}
                    </span>
                    <div className={cn('flex min-w-0 flex-col gap-1', !last && 'pb-3.5')}>
                      <span className={cn('text-xs font-semibold', WHO[kind])}>{whoLabel(e)}</span>
                      {e.file && (
                        <span className="inline-flex max-w-full items-center gap-1.5 self-start rounded-lg border bg-secondary/60 px-2 py-1 text-[12px]">
                          <FileText className="size-3.5 shrink-0 text-success" aria-hidden />
                          <span className="truncate">
                            <span className="sr-only">File shared: </span>
                            {e.file.fileName}
                          </span>
                        </span>
                      )}
                      {e.text && (
                        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-secondary-foreground wrap-break-word">
                          {e.text}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {t.messageCount > shown && (
        <p className="shrink-0 text-xs text-muted-foreground">
          Showing the latest {shown} of {t.messageCount} messages.{' '}
          <Link href={`/clients/${t.clientId}`} className="text-primary hover:underline">
            See the full chat on the client page
          </Link>
        </p>
      )}

      <div className="shrink-0 border-t border-line-soft pt-4">
        <TicketActions id={t.id} status={t.status} tag={t.tag} action={ticketAction} readOnlyNote={readOnlyNote} layout="panel">
          <DraftReplyButton ticketId={t.id} title={title} action={draftReplyAction} size="lg" />
        </TicketActions>
      </div>

      <a href="#tickets-list" className="text-xs text-primary hover:underline lg:hidden">
        Back to the ticket list
      </a>
    </PanelShell>
  )
}
