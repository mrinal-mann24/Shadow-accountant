// Pure team KPI maths for the Admin Team page. Unit tested.
import type { ClientListItem, TeamOverview } from '@/lib/data/types'

export type TeamKpis = {
  clients: number
  unassigned: number
  /** Open tickets across every client (assigned or not). */
  openTickets: number
  openEscalations: number
  /** Open tickets past SLA, on clients that have an accountant. */
  slaBreached: number
  /** Clients whose latest score shows a client message waiting for a reply. */
  unansweredClients: number
  scoredClients: number
  /** Average service score over scored clients, 1 decimal; null when none are scored. */
  avgHealth: number | null
}

export function teamKpis(overview: TeamOverview, clients: ClientListItem[]): TeamKpis {
  const scored = clients.filter((c) => c.serviceScore !== null)
  const avg = scored.length
    ? Math.round((scored.reduce((s, c) => s + (c.serviceScore ?? 0), 0) / scored.length) * 10) / 10
    : null
  return {
    clients: clients.length,
    unassigned: clients.filter((c) => !c.vaId).length,
    openTickets: clients.reduce((s, c) => s + c.openTickets, 0),
    openEscalations: overview.escalations.length,
    slaBreached: overview.accountants.reduce((s, a) => s + a.slaBreachedOpen, 0),
    unansweredClients: clients.filter((c) => (c.unansweredCount ?? 0) > 0).length,
    scoredClients: scored.length,
    avgHealth: avg,
  }
}

/** Unassigned first (newest HubSpot wins need a home), then by name. Does not mutate the input. */
export function sortForAssignment(clients: ClientListItem[]): ClientListItem[] {
  return [...clients].sort((a, b) => {
    if (!a.vaId !== !b.vaId) return a.vaId ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}
