// Senior accountant card on the Team page. Server-safe: numbers come from getTeamOverview (lib/data).
import { formatScore, scoreClass } from '@/components/admin/format'
import { cn } from '@/lib/utils'
import type { AccountantWorkload } from '@/lib/data/types'
import { accountantLoad, initials, type LoadTone } from './logic'

const AVATARS = [
  'bg-primary-soft text-accent-foreground',
  'bg-whatsapp-soft text-whatsapp',
  'bg-violet-soft text-violet',
  'bg-teal-soft text-teal',
  'bg-warning-soft text-[#8A4205]',
]

const BAR: Record<LoadTone, string> = {
  risk: 'bg-[#DC2626]',
  watch: 'bg-[#D97706]',
  calm: 'bg-[#16A34A]',
}

const DELAYS = ['anim-d1', 'anim-d2', 'anim-d3', 'anim-d4', 'anim-d5', 'anim-d6', 'anim-d7', 'anim-d8']

function Figure({ value, label, className }: { value: React.ReactNode; label: string; className?: string }) {
  return (
    <div className="flex flex-col">
      <span className={cn('font-mono text-[22px] leading-tight tabular-nums', className)}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

function Mini({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className={cn('font-mono tabular-nums', className)}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

export function AccountantCard({ a, index, teamOpenTickets }: { a: AccountantWorkload; index: number; teamOpenTickets: number }) {
  const load = accountantLoad(a, teamOpenTickets)
  return (
    <article
      className={cn('anim-rise lift flex flex-col gap-3 rounded-2xl border bg-card p-4', DELAYS[Math.min(index, DELAYS.length - 1)])}
      aria-label={a.name}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold', AVATARS[index % AVATARS.length])}
          aria-hidden
        >
          {initials(a.name)}
        </span>
        <div className="flex min-w-0 flex-col">
          <strong className="truncate text-sm font-semibold">{a.name}</strong>
          {a.status && (
            <span className={cn('text-xs capitalize', a.status === 'active' ? 'text-muted-foreground' : 'text-warning')}>{a.status}</span>
          )}
        </div>
        <span className="ml-auto flex flex-col items-end" title="Average service score of scored clients">
          <span className={cn('font-mono text-sm tabular-nums', scoreClass(a.avgServiceScore))}>{formatScore(a.avgServiceScore)}</span>
          <span className="text-[11px] text-muted-foreground">health</span>
        </span>
      </div>

      <div className="flex gap-4">
        <Figure value={a.clientCount} label="clients" />
        <Figure value={a.openTickets} label="open tickets" className={a.slaBreachedOpen > 0 ? 'text-destructive' : undefined} />
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-[#EEF0F4]"
        role="meter"
        aria-label="Share of team open tickets"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={load.share}
        title={`${load.share}% of the team's open tickets`}
      >
        <div className={cn('anim-fill h-full rounded-full', BAR[load.tone])} style={{ width: `${load.share}%` }} />
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <Mini value={a.openEscalations} label="escalations" className={a.openEscalations > 0 ? 'text-destructive' : undefined} />
        <Mini value={a.slaBreachedOpen} label="past SLA" className={a.slaBreachedOpen > 0 ? 'text-warning' : undefined} />
        <Mini value={a.unansweredClients} label="waiting" />
      </div>
    </article>
  )
}
