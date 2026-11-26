// Strip of open ticket counts per tag at the top of the Tickets page. Each card filters the list by that tag.
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { Tag } from '@/lib/council/types'
import type { TagCount } from './logic'

const LABEL_CLASS: Record<Tag, string> = {
  escalation: 'text-[#8A4205]',
  complaint: 'text-destructive',
  neutral: 'text-accent-foreground',
  positive: 'text-success',
  suspense: 'text-violet',
}

export function TicketTypeStrip({
  counts,
  untagged,
  activeTag,
  q,
}: {
  counts: TagCount[]
  untagged: number
  activeTag?: string
  q?: string
}) {
  const href = (tag: Tag) => {
    const sp = new URLSearchParams()
    if (activeTag !== tag) sp.set('tag', tag)
    if (q) sp.set('q', q)
    const s = sp.toString()
    return s ? `/tickets?${s}` : '/tickets'
  }
  return (
    <section aria-label="Open tickets by type" className="anim-rise anim-d1 mb-4">
      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {counts.map((c) => {
          const active = activeTag === c.tag
          return (
            <li key={c.tag}>
              <Link
                href={href(c.tag)}
                aria-current={active ? 'true' : undefined}
                aria-label={`${c.label}: ${c.count} open. ${c.definition}. ${active ? 'Showing only this type, select to show all.' : 'Select to show only this type.'}`}
                className={cn(
                  'lift flex h-full flex-col gap-1 rounded-[14px] border bg-card px-3.5 py-3',
                  active && 'border-primary ring-2 ring-primary/20',
                )}
              >
                <span className={cn('text-xs font-medium', LABEL_CLASS[c.tag])}>{c.label}</span>
                <span className="font-mono text-[22px] leading-tight tabular-nums">{c.count}</span>
                <span className="text-[11px] leading-snug text-muted-foreground">{c.definition}</span>
              </Link>
            </li>
          )
        })}
      </ul>
      {untagged > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {untagged} open {untagged === 1 ? 'ticket has' : 'tickets have'} no tag yet.
        </p>
      )}
    </section>
  )
}
