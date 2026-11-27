// Small pieces shared by ticket rows (Home, Client 360, Tickets). No hooks: usable from server components.
import type { ConversationItem } from '@/lib/data/types'
import { cn } from '@/lib/utils'
import { sideBadge, URGENCY_LABELS, type TicketUrgency } from './logic'

/** Red "Pending from client" or green "We replied" on an open ticket; nothing while the client waits on us. */
export function SideBadge({ ticket }: { ticket: ConversationItem }) {
  const b = sideBadge(ticket)
  if (!b) return null
  return (
    <span
      className={cn(
        'rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        b.tone === 'client' ? 'bg-destructive-soft text-destructive' : 'bg-success-soft text-success',
      )}
    >
      {b.label}
    </span>
  )
}

// Colours also differ in lightness: dark red, amber, green, light grey.
const DOT: Record<TicketUrgency, string> = {
  breached: 'bg-destructive live-red',
  'waiting-long': 'bg-destructive live-red',
  waiting: 'bg-warning',
  replied: 'bg-success',
  closed: 'bg-muted-foreground/35',
}

const AGE: Record<TicketUrgency, string> = {
  breached: 'text-destructive',
  'waiting-long': 'text-destructive',
  waiting: 'text-warning',
  replied: 'text-success',
  closed: 'text-muted-foreground',
}

/** Status dot with a screen reader label (status never relies on colour alone). */
export function StatusDot({ urgency, className }: { urgency: TicketUrgency; className?: string }) {
  return (
    <span className={cn('inline-flex size-2.5 shrink-0 rounded-full', DOT[urgency], className)} role="img" aria-label={URGENCY_LABELS[urgency]} />
  )
}

/** Short age on the right of a row, coloured like the dot. */
export function AgeText({ urgency, children, title }: { urgency: TicketUrgency; children: React.ReactNode; title?: string }) {
  return (
    <span className={cn('font-mono text-xs whitespace-nowrap tabular-nums', AGE[urgency])} title={title}>
      {children}
    </span>
  )
}
