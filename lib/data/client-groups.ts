// How the Clients screen groups rows. Pure, safe anywhere (no DB, no server-only imports).
//
// Rule (business owner, 26 Nov 2026):
// - A client is a top-level row (no parent) with a HubSpot deal and status Active: tab "clients".
// - Top-level Active rows with no HubSpot deal: tab "other" (usually a new client whose deal is not linked yet).
// - Top-level Inactive rows: tab "past".
// - WhatsApp subgroups (parent_client_id set) are nested inside their parent, whatever their own status.
// - A subgroup whose parent is not in the list (out of the user's scope, or missing) becomes its own top-level row,
//   in the tab of its own deal and status, so nothing disappears.

import { isActiveClient } from './client-status'
import type { ClientListItem } from './types'

export const CLIENT_TABS = ['clients', 'other', 'past'] as const
export type ClientTab = (typeof CLIENT_TABS)[number]

export type ClientSubgroup = {
  client: ClientListItem
  displayName: string
  /** True when a search is active and this subgroup matched it. */
  matched: boolean
}

export type ClientGroup = {
  client: ClientListItem
  displayName: string
  tab: ClientTab
  subgroups: ClientSubgroup[]
  /** A subgroup shown on its own because its parent is not in the list. */
  orphan: boolean
  /** The search matched a subgroup but not the parent itself; the row should open on that subgroup. */
  matchedBySubgroup: boolean
  /** Totals across the parent and its subgroups. */
  openTickets: number
  openEscalations: number
  lastMessageAt: string | null
  waitingForReply: boolean
}

export type GroupedClients = Record<ClientTab, ClientGroup[]>

export function parseClientTab(value: string | null | undefined): ClientTab {
  return (CLIENT_TABS as readonly string[]).includes(value ?? '') ? (value as ClientTab) : 'clients'
}

export function hasHubspotDeal(c: Pick<ClientListItem, 'hubspotDealId'>): boolean {
  return (c.hubspotDealId ?? '').trim() !== ''
}

// " <> VA", "<>VA", "<> Virtual Accounting", "<> Virtual Accounting services", "<> AIA", "-  VA", " x VA",
// " - Virtual Accounting Team" and the like.
const GROUP_SUFFIX = /(?:\s*<>|\s*-|\s+x)\s*(?:virtual\s+accounting(?:\s+(?:services?|team))?|va|aia)\s*$/i

/** WhatsApp group name without the team suffix; '' when nothing is left. */
export function cleanGroupName(name: string | null | undefined): string {
  let out = (name ?? '').trim()
  for (let i = 0; i < 3; i++) {
    const next = out.replace(GROUP_SUFFIX, '').trim()
    if (next === out) break
    out = next
  }
  return out
}

/** The business name to lead with: the cleaned WhatsApp group name, else client_name. */
export function displayNameOf(c: Pick<ClientListItem, 'name' | 'whatsappGroupName'>): string {
  return cleanGroupName(c.whatsappGroupName) || c.name
}

function tabOf(c: ClientListItem): ClientTab {
  if (!isActiveClient(c.status)) return 'past'
  return hasHubspotDeal(c) ? 'clients' : 'other'
}

function matchesQuery(c: ClientListItem, displayName: string, q: string): boolean {
  return [c.name, c.legalName, c.whatsappGroupName, displayName].some((v) => v?.toLowerCase().includes(q))
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}

const byName = (a: { displayName: string }, b: { displayName: string }) =>
  a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' })

/**
 * Splits the user's clients (already scoped by lib/data listClients) into the three tabs, with subgroups nested.
 * `search` keeps a row when the parent or any of its subgroups matches name, legal name or group name.
 * Rows are sorted by open tickets (most first), then name; subgroups by name.
 */
export function groupClients(items: ClientListItem[], opts: { search?: string } = {}): GroupedClients {
  const byId = new Map(items.map((c) => [c.id, c]))
  const isTop = (c: ClientListItem) => !c.parentClientId || !byId.has(c.parentClientId)

  // Root ancestor for each nested row (walks deeper chains; a cycle makes the row its own root).
  const rootOf = (c: ClientListItem): ClientListItem => {
    const seen = new Set<string>([c.id])
    let cur = c
    while (!isTop(cur)) {
      const parent = byId.get(cur.parentClientId as string) as ClientListItem
      if (seen.has(parent.id)) return c
      seen.add(parent.id)
      cur = parent
    }
    return cur
  }

  const children = new Map<string, ClientListItem[]>()
  const roots: ClientListItem[] = []
  for (const c of items) {
    const root = rootOf(c)
    if (root.id === c.id) roots.push(c)
    else children.set(root.id, [...(children.get(root.id) ?? []), c])
  }

  const q = (opts.search ?? '').trim().toLowerCase()
  const out: GroupedClients = { clients: [], other: [], past: [] }

  for (const root of roots) {
    const displayName = displayNameOf(root)
    const subgroups: ClientSubgroup[] = (children.get(root.id) ?? [])
      .map((s) => {
        const name = displayNameOf(s)
        return { client: s, displayName: name, matched: q !== '' && matchesQuery(s, name, q) }
      })
      .sort(byName)
    const parentMatched = q === '' || matchesQuery(root, displayName, q)
    const anySubMatched = subgroups.some((s) => s.matched)
    if (!parentMatched && !anySubMatched) continue

    const all = [root, ...subgroups.map((s) => s.client)]
    const tab = tabOf(root)
    out[tab].push({
      client: root,
      displayName,
      tab,
      subgroups,
      orphan: Boolean(root.parentClientId),
      matchedBySubgroup: !parentMatched && anySubMatched,
      openTickets: all.reduce((n, c) => n + c.openTickets, 0),
      openEscalations: all.reduce((n, c) => n + c.openEscalations, 0),
      lastMessageAt: all.reduce<string | null>((at, c) => latest(at, c.lastMessageAt), null),
      waitingForReply: all.some((c) => (c.unansweredCount ?? 0) > 0),
    })
  }

  for (const tab of CLIENT_TABS) out[tab].sort((a, b) => b.openTickets - a.openTickets || byName(a, b))
  return out
}

/** Number of nested subgroups across a list of groups. */
export function subgroupCount(groups: ClientGroup[]): number {
  return groups.reduce((n, g) => n + g.subgroups.length, 0)
}

/** Up to two initials for the avatar, from words that start with a letter or digit. */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w))
  const letters = words.slice(0, 2).map((w) => w[0])
  return (letters.join('') || '?').toUpperCase()
}
