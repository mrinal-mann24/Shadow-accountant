// Turns grouped clients into plain props for the client rows. Runs on the server so relative times are computed once
// (no hydration mismatch). Pure.
import { formatAgo, formatDateTime, formatDelta, healthTone, type HealthTone } from '@/components/accountant/logic'
import { hasHubspotDeal, initialsOf, type ClientGroup } from '@/lib/data/client-groups'
import { isActiveClient } from '@/lib/data/client-status'
import { AVATAR_CLASSES } from './grid'

export type SubgroupView = {
  id: string
  name: string
  openTickets: number
  inactive: boolean
  matched: boolean
}

export type ClientRowView = {
  id: string
  name: string
  initials: string
  tint: number
  /** HubSpot / client_name and deal stage, already joined. */
  dealLine: string
  senior: string | null
  mainGroupName: string | null
  groupCount: number
  openTickets: number
  openEscalations: number
  score: number | null
  deltaLabel: string
  tone: HealthTone
  lastIso: string | null
  lastLabel: string
  lastTitle: string
  waitingForReply: boolean
  badge: 'no-deal' | 'subgroup' | null
  defaultOpen: boolean
  subgroups: SubgroupView[]
}

function tintOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % AVATAR_CLASSES.length
}

export function toRowView(g: ClientGroup, now: Date): ClientRowView {
  const c = g.client
  return {
    id: c.id,
    name: g.displayName,
    initials: initialsOf(g.displayName),
    tint: tintOf(c.id),
    dealLine: [c.name, c.dealStage].filter(Boolean).join(' · '),
    senior: c.vaName,
    mainGroupName: c.whatsappGroupName?.trim() || null,
    groupCount: 1 + g.subgroups.length,
    openTickets: g.openTickets,
    openEscalations: g.openEscalations,
    score: c.serviceScore,
    deltaLabel: formatDelta(c.serviceDelta),
    tone: healthTone(c.serviceScore),
    lastIso: g.lastMessageAt,
    lastLabel: g.lastMessageAt ? formatAgo(g.lastMessageAt, now) : '',
    lastTitle: g.lastMessageAt ? formatDateTime(g.lastMessageAt) : '',
    waitingForReply: g.waitingForReply,
    badge: g.orphan ? 'subgroup' : g.tab === 'other' && !hasHubspotDeal(c) ? 'no-deal' : null,
    defaultOpen: g.matchedBySubgroup,
    subgroups: g.subgroups.map((s) => ({
      id: s.client.id,
      name: s.displayName,
      openTickets: s.client.openTickets,
      inactive: !isActiveClient(s.client.status),
      matched: s.matched,
    })),
  }
}
