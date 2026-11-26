// Pure helpers for the Team page accountant cards. Server-safe, unit tested.
import type { AccountantWorkload } from '@/lib/data/types'

/** "Ajith Kumar" -> "AK", "Gayathri" -> "GA", "" -> "?". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

export type LoadTone = 'risk' | 'watch' | 'calm'

export type AccountantLoad = {
  /** This accountant's share of the open tickets on assigned clients, 0 to 100. */
  share: number
  /** risk: open escalations or SLA breaches; watch: clients waiting for a reply; calm: neither. */
  tone: LoadTone
}

type LoadInput = Pick<AccountantWorkload, 'openTickets' | 'openEscalations' | 'slaBreachedOpen' | 'unansweredClients'>

export function accountantLoad(a: LoadInput, teamOpenTickets: number): AccountantLoad {
  const share = teamOpenTickets > 0 ? Math.min(100, Math.round((a.openTickets / teamOpenTickets) * 100)) : 0
  const tone: LoadTone =
    a.openEscalations > 0 || a.slaBreachedOpen > 0 ? 'risk' : a.unansweredClients > 0 ? 'watch' : 'calm'
  return { share, tone }
}

/** Open tickets on clients that have an accountant (the base for each card's share). */
export function assignedOpenTickets(accountants: Pick<AccountantWorkload, 'openTickets'>[]): number {
  return accountants.reduce((s, a) => s + a.openTickets, 0)
}
