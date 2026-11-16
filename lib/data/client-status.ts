// clients.status holds "Active" or "Inactive". The HubSpot sync sets it from the deal stage
// (specs/hubspot-sync-v2.md): Churned and AM Parked deals are Inactive. Pure, safe anywhere.

export const CLIENT_STATUS_ACTIVE = 'Active'
export const CLIENT_STATUS_INACTIVE = 'Inactive'

export type ClientStatusFilter = 'active' | 'inactive' | 'all'

/** Anything not marked Inactive counts as active, so a client with no status is never hidden. */
export function isActiveClient(status: string | null | undefined): boolean {
  return (status ?? '').trim().toLowerCase() !== CLIENT_STATUS_INACTIVE.toLowerCase()
}

export function matchesStatusFilter(status: string | null | undefined, filter: ClientStatusFilter): boolean {
  if (filter === 'all') return true
  return filter === 'active' ? isActiveClient(status) : !isActiveClient(status)
}
