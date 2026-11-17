// Small presentational pieces for the Senior Accountant screens. No hooks: usable from server components.
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Direction } from '@/lib/data/types'
import { formatDelta, healthTone, sparklinePoints } from './logic'
import { isTag, TAG_LABELS } from './ticket-intent'

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function Section({
  title,
  action,
  className,
  children,
}: {
  title: string
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={cn('gap-4 py-4', className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-4">
        <CardTitle className="text-base">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  )
}

export function KpiCard({ label, value, hint, alert }: { label: string; value: React.ReactNode; hint?: string; alert?: boolean }) {
  return (
    <Card className="gap-1 px-4 py-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-2xl font-semibold tabular-nums', alert && 'text-destructive')}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Card>
  )
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>
}

const TAG_CLASSES: Record<string, string> = {
  escalation: 'bg-destructive/10 text-destructive',
  complaint: 'bg-warning/10 text-warning',
  positive: 'bg-success/10 text-success',
  neutral: 'bg-secondary text-muted-foreground',
  suspense: 'bg-primary/10 text-primary',
}

export function TagBadge({ tag }: { tag: string | null }) {
  if (!tag) return <Badge variant="outline">No tag</Badge>
  const label = isTag(tag) ? TAG_LABELS[tag] : tag
  return <Badge variant="secondary" className={TAG_CLASSES[tag] ?? 'bg-secondary text-muted-foreground'}>{label}</Badge>
}

export function SlaBadge() {
  return <Badge variant="secondary" className="bg-destructive text-white">SLA breached</Badge>
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={status === 'open' ? 'text-foreground' : 'text-muted-foreground'}>
      {status === 'open' ? 'Open' : status === 'closed' ? 'Closed' : status}
    </Badge>
  )
}

const TONE_CLASSES = {
  good: 'text-success',
  watch: 'text-warning',
  risk: 'text-destructive',
  none: 'text-muted-foreground',
} as const

/** Score with an optional delta, coloured by band. Shows "Not scored" when null. */
export function HealthValue({ score, delta, className }: { score: number | null; delta?: number | null; className?: string }) {
  if (score === null) return <span className={cn('text-sm text-muted-foreground', className)}>Not scored</span>
  const d = formatDelta(delta)
  return (
    <span className={cn('inline-flex items-baseline gap-1 tabular-nums', className)}>
      <span className={cn('font-semibold', TONE_CLASSES[healthTone(score)])}>{score}</span>
      {d && (
        <span
          className={cn('text-xs', (delta ?? 0) > 0 ? 'text-success' : (delta ?? 0) < 0 ? 'text-destructive' : 'text-muted-foreground')}
          title="Change since the previous day"
        >
          {d}
        </span>
      )}
    </span>
  )
}

export function DirectionLabel({ direction }: { direction: Direction }) {
  const incoming = direction === 'incoming'
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', incoming ? 'text-foreground' : 'text-muted-foreground')}>
      <Icon className="size-3" aria-hidden />
      {incoming ? 'From client' : 'From team'}
    </span>
  )
}

/** Small inline SVG trend of service (solid) and mood (dashed) scores, 0 to 100. */
export function ScoreTrend({ service, mood }: { service: number[]; mood: number[] }) {
  const w = 240
  const h = 48
  if (service.length < 2) {
    return <p className="text-xs text-muted-foreground">Trend appears after two days of scores.</p>
  }
  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-12 w-full max-w-60 overflow-visible"
        role="img"
        aria-label={`Service score trend over ${service.length} days, from ${service[0]} to ${service[service.length - 1]}`}
        preserveAspectRatio="none"
      >
        <line x1="0" y1={h / 2} x2={w} y2={h / 2} className="stroke-border" strokeWidth="1" />
        <polyline points={sparklinePoints(mood, w, h)} fill="none" stroke="#666666" strokeWidth="1.5" strokeDasharray="3 3" />
        <polyline points={sparklinePoints(service, w, h)} fill="none" stroke="#000000" strokeWidth="2" />
      </svg>
      <figcaption className="flex gap-4 text-xs text-muted-foreground">
        <span>Solid: service</span>
        <span>Dashed: mood</span>
      </figcaption>
    </figure>
  )
}
