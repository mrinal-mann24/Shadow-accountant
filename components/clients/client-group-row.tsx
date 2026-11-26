'use client'

// One client row with its WhatsApp subgroups folded inside (chevron to expand). The only client state is open/closed.
import Link from 'next/link'
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AVATAR_CLASSES, GRID_NO_SENIOR, GRID_WITH_SENIOR, TONE_BAR, TONE_CHIP } from './grid'
import type { ClientRowView } from './view'

export function ClientGroupRow({ row, showSenior }: { row: ClientRowView; showSenior: boolean }) {
  const [open, setOpen] = useState(row.defaultOpen)
  const panelId = useId()
  const hasSubs = row.subgroups.length > 0
  const isOpen = hasSubs && open

  return (
    <li className="border-b border-line-soft last:border-b-0">
      <div
        className={cn(
          'relative grid grid-cols-1 gap-3 px-4 py-3.5 transition-colors hover:bg-[#F8F9FB] xl:items-center xl:px-5',
          showSenior ? GRID_WITH_SENIOR : GRID_NO_SENIOR,
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {hasSubs ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={isOpen}
              aria-controls={panelId}
              aria-label={`${isOpen ? 'Hide' : 'Show'} groups of ${row.name}`}
              className="press relative z-10 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-[#374151] hover:bg-border"
            >
              <ChevronRight className={cn('size-3.5 transition-transform duration-300 ease-spring', isOpen && 'rotate-90')} aria-hidden />
            </button>
          ) : (
            <span className="flex size-7 shrink-0 items-center justify-center text-border" aria-hidden>
              <ChevronRight className="size-3.5" />
            </span>
          )}
          <span
            className={cn(
              'flex size-[34px] shrink-0 items-center justify-center rounded-[10px] text-xs font-semibold',
              AVATAR_CLASSES[row.tint % AVATAR_CLASSES.length],
            )}
            aria-hidden
          >
            {row.initials}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <Link
                href={`/clients/${row.id}`}
                className="truncate text-sm font-semibold text-foreground after:absolute after:inset-0 hover:text-primary"
              >
                {row.name}
              </Link>
              {row.badge === 'no-deal' && (
                <span className="shrink-0 rounded-full bg-warning-soft px-2.5 py-0.5 text-xs text-[#8A4205]">No deal linked</span>
              )}
              {row.badge === 'subgroup' && (
                <span
                  className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground"
                  title="A WhatsApp subgroup whose main group is not in your list"
                >
                  Subgroup
                </span>
              )}
            </span>
            {row.dealLine && <span className="truncate text-xs text-muted-foreground">{row.dealLine}</span>}
            <span className="truncate text-xs text-muted-foreground xl:hidden">
              {[
                showSenior ? (row.senior ?? 'Unassigned') : null,
                `${row.groupCount} ${row.groupCount === 1 ? 'group' : 'groups'}`,
                `${row.openTickets} open`,
                row.score === null ? 'Not scored' : `Health ${row.score}`,
                row.lastLabel || null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        </div>

        {showSenior && (
          <span className={cn('hidden truncate text-[13px] xl:block', !row.senior && 'text-muted-foreground')}>
            {row.senior ?? 'Unassigned'}
          </span>
        )}

        <span className="hidden font-mono text-[13px] tabular-nums xl:block">
          {row.groupCount} {row.groupCount === 1 ? 'group' : 'groups'}
        </span>

        <span className="hidden font-mono text-[13px] tabular-nums xl:block">
          <span className={row.openTickets >= 3 ? 'text-destructive' : row.openTickets > 0 ? 'text-foreground' : 'text-meta'}>
            {row.openTickets}
          </span>
          {row.openEscalations > 0 && (
            <span className="ml-1.5 font-sans text-xs text-destructive" title="Open escalations">
              {row.openEscalations} esc.
            </span>
          )}
        </span>

        <div className="hidden items-center gap-2.5 xl:flex">
          {row.score === null ? (
            <span className="text-[13px] text-muted-foreground">Not scored</span>
          ) : (
            <>
              <span className={cn('rounded-md px-2 py-0.5 font-mono text-xs font-medium tabular-nums', TONE_CHIP[row.tone])}>
                {row.score}
              </span>
              <span className="h-1.5 max-w-[110px] flex-1 overflow-hidden rounded-full bg-[#EEF0F4]" aria-hidden>
                <span
                  className={cn('anim-fill block h-full rounded-full', TONE_BAR[row.tone])}
                  style={{ width: `${Math.max(0, Math.min(100, row.score))}%` }}
                />
              </span>
              {row.deltaLabel && (
                <span className="font-mono text-xs text-muted-foreground" title="Change since the previous day">
                  {row.deltaLabel}
                </span>
              )}
            </>
          )}
        </div>

        <span className="hidden min-w-0 flex-col text-[13px] text-muted-foreground xl:flex">
          {row.lastIso ? (
            <time dateTime={row.lastIso} title={row.lastTitle} className="truncate">
              {row.lastLabel}
            </time>
          ) : (
            <span className="truncate">No messages yet</span>
          )}
          {row.waitingForReply && <span className="text-xs text-destructive">Waiting for reply</span>}
        </span>
      </div>

      {isOpen && (
        <div id={panelId} className="anim-drop flex flex-col gap-1.5 bg-[#FBFBFC] px-4 pt-1 pb-4 xl:pr-5 xl:pl-[74px]">
          <span className="py-1.5 text-xs text-meta">WhatsApp groups inside {row.name}</span>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <li>
              <Link
                href={`/clients/${row.id}`}
                className="flex min-w-0 items-center gap-2 rounded-[10px] border border-[#DCE3F7] bg-[#F5F7FE] px-2.5 py-2 hover:border-primary"
              >
                <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
                <span className="truncate text-[13px] font-medium" title={row.mainGroupName ?? undefined}>
                  Main group
                </span>
              </Link>
            </li>
            {row.subgroups.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/clients/${s.id}`}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-[10px] border bg-card px-2.5 py-2 hover:border-primary',
                    s.matched ? 'border-primary bg-primary-soft' : 'border-[#EEF0F4]',
                  )}
                >
                  <span className={cn('size-2 shrink-0 rounded-full', s.inactive ? 'bg-border' : 'bg-[#9AA3B2]')} aria-hidden />
                  <span className={cn('min-w-0 flex-1 truncate text-[13px]', s.inactive ? 'text-meta' : 'text-[#374151]')} title={s.name}>
                    {s.name}
                  </span>
                  {s.inactive && <span className="shrink-0 text-xs text-meta">Inactive</span>}
                  {s.openTickets > 0 && (
                    <span className="shrink-0 font-mono text-xs text-destructive" title="Open tickets">
                      {s.openTickets} open
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}
