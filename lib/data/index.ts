// Server-only data access. Every function takes the AppUser and enforces scope with the service-role
// client (temporary rule until RLS policies are approved; see docs/agents/CONTRACTS.md).
import 'server-only'

export { listClients, getClient, listVas, assignClient, setCouncilEnabled } from './clients'
export { listMessages } from './messages'
export { listConversations, updateConversation, ticketForUser, reassignTicket } from './conversations'
export { getClientScores, getScoreHistory } from './scores'
export { listDocuments, listMeetings } from './documents'
export { getTimeline, listRecentActivity } from './timeline'
export { getTeamOverview, getSystemHealth, getCouncilUsage, retryProcessing } from './admin'
export { scopeOf, canAccessClient, scopedClientIds } from './scope'
export { ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'
export type * from './types'
