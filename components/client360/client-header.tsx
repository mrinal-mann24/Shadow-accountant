// Client 360 header card: initials, business name, chips (deal stage, accountant, groups), health ring and counts.
// No hooks: a server component.
import Link from 'next/link'
import { healthTone } from '@/components/accountant/logic'
import { cn } from '@/lib/utils'
import { healthLabel, initials, ringOffset } from './name'

const RING_STROKE = { good: '#0e7a4f', watch: '#b45309', risk: '#b42318', none: '#e3e6ec' } as const

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full items-center truncate rounded-full bg-secondary px-2.5 py-0.5 text-xs text-[#374151]', className)}>
      {children}
    </span>
  )
}

/** Paid-looking deal stages read green; anything else stays neutral. */
function stageTone(stage: string): string {
  return /paid|payment|won|active/i.test(stage) ? 'bg-success-soft text-success' : 'bg-primary-soft text-accent-foreground'
}

export function HealthRing({ score, reason }: { score: number | null; reason: string | null }) {
  const tone = healthTone(score)
  return (
    <div className="flex items-center gap-3">
      <svg
        width="64"
        height="64"
        viewBox="0 0 100 100"
        role="img"
        aria-label={score === null ? 'Health not scored yet' : `Health score ${score} out of 100`}
        className="shrink-0"
      >
        <circle cx="50" cy="50" r="42" fill="none" stroke="#eef0f4" strokeWidth="10" />
        {score !== null && (
          <circle
            className="anim-ring"
            cx="50"
            cy="50"
            r="42"
            fill="none"
            stroke={RING_STROKE[tone]}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray="264"
            strokeDashoffset={ringOffset(score)}
            transform="rotate(-90 50 50)"
          />
        )}
        <text
          x="50"
          y={score === null ? 55 : 58}
          textAnchor="middle"
          className="fill-foreground font-mono"
          fontSize={score === null ? 16 : 26}
        >
          {score === null ? '-' : score}
        </text>
      </svg>
      <div className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-[13px] font-semibold">{healthLabel(score)}</strong>
        <span className="max-w-56 text-xs text-muted-foreground">
          {score === null ? 'Appears after the daily health score run' : (reason ?? 'Service score')}
        </span>
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[22px] leading-tight tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

export function ClientHeader({
  name,
  dealName,
  dealStage,
  accountant,
  groupCount,
  parent,
  score,
  reason,
  openTickets,
  unanswered,
  action,
}: {
  name: string
  /** The HubSpot deal / client name when it differs from the business name. */
  dealName: string | null
  dealStage: string | null
  accountant: string | null
  /** This group plus its sub-groups, when it has any. */
  groupCount: number
  /** Parent group, when this client is a sub-group the user can see. */
  parent: { id: string; name: string } | null
  score: number | null
  reason: string | null
  openTickets: number
  unanswered: number | null
  action: React.ReactNode
}) {
  return (
    <header className="anim-rise anim-d1 flex flex-wrap items-center gap-6 rounded-[20px] border bg-card px-5 py-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] sm:px-6">
      <div className="flex min-w-0 flex-[1_1_300px] items-center gap-4">
        <span
          className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-lg font-semibold text-accent-foreground"
          aria-hidden
        >
          {initials(name)}
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.03em] break-words sm:text-[28px]">{name}</h1>
          {dealName && <p className="text-[13px] text-muted-foreground break-words">Deal: {dealName}</p>}
          <div className="flex flex-wrap gap-1.5">
            {dealStage && <Chip className={stageTone(dealStage)}>{dealStage}</Chip>}
            <Chip>Senior: {accountant ?? 'Unassigned'}</Chip>
            {groupCount > 1 && <Chip>{groupCount} WhatsApp groups</Chip>}
            {parent && (
              <Link
                href={`/clients/${encodeURIComponent(parent.id)}`}
                className="inline-flex max-w-full items-center truncate rounded-full bg-secondary px-2.5 py-0.5 text-xs text-[#374151] hover:bg-primary-soft hover:text-accent-foreground"
              >
                Sub-group of {parent.name}
              </Link>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-7 gap-y-4">
        <HealthRing score={score} reason={reason} />
        <Stat value={openTickets} label={openTickets === 1 ? 'open ticket' : 'open tickets'} />
        {unanswered !== null && <Stat value={unanswered} label="unanswered" />}
        {action}
      </div>
    </header>
  )
}
