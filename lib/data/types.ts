// Item types returned by lib/data. Plain JSON (timestamps are ISO strings), so they can be passed from
// server components to client components. Safe to import anywhere (types only).

import type { Direction } from '@/lib/team/phone'
import type { CouncilUsage } from './usage'

export type { Direction }
export type { VerdictRow, ModelUsage, CouncilUsage } from './usage'

export type ClientListItem = {
  id: string
  name: string
  legalName: string | null
  status: string | null
  dealStage: string | null
  vaId: string | null
  vaName: string | null
  whatsappGroupName: string | null
  councilEnabled: boolean
  parentClientId: string | null
  /** clients.hubspot_deal_id. Set by listClients and getClient; optional so hand-built fixtures stay valid. */
  hubspotDealId?: string | null
  /** From client_scores; null until the health score job has scored the client. */
  serviceScore: number | null
  moodScore: number | null
  serviceDelta: number | null
  moodDelta: number | null
  scoreComputedAt: string | null
  lastMessageAt: string | null
  unansweredCount: number | null
  worstLagMinutes: number | null
  openTickets: number
  openEscalations: number
}

export type ContactItem = {
  id: string
  name: string | null
  role: string | null
  whatsappNumber: string
  isPrimary: boolean
}

export type ClientDetail = ClientListItem & {
  email: string | null
  gstin: string | null
  entityType: string | null
  industry: string | null
  city: string | null
  state: string | null
  onboardingDate: string | null
  hubspotDealId: string | null
  whatsappGroupId: string | null
  topReasons: string[]
  contacts: ContactItem[]
}

export type MessageItem = {
  id: string
  /** WhatsApp message id (client_messages.dedup_hash). */
  waMessageId: string
  at: string
  body: string
  senderName: string | null
  /** Effective direction: outgoing when the sender is a team number. Use this, not storedDirection. */
  direction: Direction
  storedDirection: string | null
  /** True when the sender phone is a known team number. */
  fromTeam: boolean
  messageType: string | null
  conversationId: string | null
}

export type ConversationStatus = 'open' | 'closed'

export type ConversationItem = {
  id: string
  clientId: string
  clientName: string | null
  vaId: string | null
  title: string | null
  summary: string
  status: string
  tag: string | null
  fault: string | null
  clientTone: string | null
  vaTone: string | null
  slaBreached: boolean
  openedAt: string
  openedBy: string
  closedAt: string | null
  lastMessageAt: string
  /** As stored by the council (may use the unreliable stored direction). */
  lastMessageDirection: string | null
  messageCount: number
  /** Closed tickets only: 'ai' when the ticket council closed it, 'person' when someone did. Unset when unknown. */
  closedBy?: ClosedBy
}

export type ClosedBy = 'ai' | 'person'

export type ConversationPatch = { status?: ConversationStatus; tag?: string; summary?: string; title?: string }

export type ScoreItem = {
  clientId: string
  vaId: string | null
  serviceScore: number
  moodScore: number
  serviceDelta: number | null
  moodDelta: number | null
  openIssues: number
  complaints7d: number
  ourFault7d: number
  unansweredCount: number
  worstLagMinutes: number | null
  topReasons: string[]
  computedAt: string
  lastMessageAt: string | null
}

export type ScoreHistoryItem = {
  clientId: string
  date: string
  serviceScore: number
  moodScore: number
  openIssues: number
  complaints7d: number
  ourFault7d: number
  computedAt: string
}

export type DocumentItem = {
  id: string
  clientId: string | null
  fileName: string | null
  /** SharePoint folder (document_uploads.folder_name). */
  folderName: string
  /** folder_name / file_name, for display. */
  path: string
  fileType: string | null
  fileSize: number | null
  uploadedAt: string | null
  groupName: string | null
  /** Always null for now: document_uploads has no URL column and we do not guess SharePoint links. */
  url: string | null
}

export type MeetingItem = {
  id: string
  clientId: string | null
  subject: string | null
  start: string | null
  end: string | null
  date: string | null
  durationMinutes: number | null
  organizerName: string | null
  pocName: string | null
  meetingType: string | null
  transcriptStatus: string | null
  hasTranscript: boolean
  /** Teams join link when stored. */
  link: string | null
}

export type TimelineKind = 'message' | 'document' | 'meeting' | 'ticket'

export type TimelineItem = {
  kind: TimelineKind
  /** Id in the source table (message_id, upload_id, meeting id, conversation id). */
  id: string
  at: string
  clientId: string
  title: string
  detail: string | null
  /** Messages only. */
  direction?: Direction
  link: string | null
}

export type ActivityItem = TimelineItem & { clientName: string | null }

export type VaItem = {
  id: string
  name: string
  email: string | null
  status: string | null
  /** Clients with clients.va_id = this accountant (computed, not vas.client_count). */
  clientCount: number
}

export type AccountantWorkload = {
  vaId: string
  name: string
  status: string | null
  clientCount: number
  openTickets: number
  openEscalations: number
  slaBreachedOpen: number
  /** Clients whose latest score shows an unanswered client message. */
  unansweredClients: number
  avgServiceScore: number | null
}

export type TeamOverview = {
  accountants: AccountantWorkload[]
  unassignedClients: number
  /** Open tickets tagged escalation, newest activity first. */
  escalations: ConversationItem[]
  /** Up to 10 scored clients with the lowest service score. */
  lowestHealth: ClientListItem[]
  /** Raw settings value 'hubspot_last_sync' (ISO time of the last write-mode HubSpot sync); null when it has not run. */
  hubspotLastSync: string | null
}

export type ProcessingFailure = {
  messageId: string
  status: string
  error: string | null
  attempts: number
  maxAttempts: number
  createdAt: string
  processedAt: string | null
}

export type SystemHealth = {
  lastMessageAt: string | null
  messagesLast24h: number
  processing: {
    /** message_processing_log rows with status 'pending' (put back by Retry). */
    pending: number
    /** client_messages from council-enabled clients with processed_at null. */
    councilBacklog: number
    failed: number
    recentFailures: ProcessingFailure[]
  }
  /** Latest client_scores.computed_at. */
  lastScoreRunAt: string | null
  councilClients: { id: string; name: string }[]
  teamNumbersCount: number
  /** Raw settings value 'hubspot_last_sync' written by the HubSpot sync job; null when it has not run. */
  hubspotLastSync: string | null
  /** Newest council_verdicts.created_at overall; null when the council has never run. */
  lastCouncilVerdictAt: string | null
}

export type CouncilUsageReport = CouncilUsage & {
  /** Every verdict ever stored. */
  totalVerdicts: number
  /** Newest verdict overall (may be older than the window). */
  lastVerdictEverAt: string | null
}
