// Shared contract for the Shadow Teams bot (lib/teams/*). Every module codes against these types, so the
// pieces can be built and tested on their own. Server only; nothing here touches the browser.
//
// Flow:
//   Teams -> POST /api/teams/messages (auth.ts verifies the Bot Framework JWT) -> bot.ts handles the activity
//   cron  -> GET  /api/jobs/teams-notify (notify.ts) -> cards.ts builds cards -> connector.ts posts them
//   store.ts keeps the channel map (settings key 'teams_channels') and the teams_notifications table.

import type { AppUser } from '@/lib/auth/types'
import type { ChatTurn } from '@/lib/agent/scope'
import type { SaveProposal } from './chat'

// ---------------------------------------------------------------- Bot Framework activities (subset we use)

export type ChannelAccount = { id: string; name?: string; aadObjectId?: string }

export type Activity = {
  type: string // 'message' | 'invoke' | 'conversationUpdate' | 'installationUpdate' | ...
  id?: string
  name?: string // invoke name, e.g. 'adaptiveCard/action'
  text?: string
  value?: unknown
  serviceUrl: string
  channelId: string // 'msteams'
  from: ChannelAccount
  recipient?: ChannelAccount
  conversation: { id: string; conversationType?: string; tenantId?: string; isGroup?: boolean }
  channelData?: {
    tenant?: { id: string }
    team?: { id: string; name?: string }
    channel?: { id: string; name?: string }
    eventType?: string
  }
  entities?: { type: string; mentioned?: ChannelAccount; text?: string }[]
  membersAdded?: ChannelAccount[]
  replyToId?: string
}

export type AdaptiveCard = { type: 'AdaptiveCard'; version: string; body: unknown[]; actions?: unknown[]; [k: string]: unknown }

export type OutgoingActivity = {
  type: 'message'
  text?: string
  textFormat?: 'markdown' | 'plain' | 'xml'
  attachments?: { contentType: 'application/vnd.microsoft.card.adaptive'; content: AdaptiveCard }[]
  entities?: unknown[]
}

/** Raised by auth.ts when a request is not a genuine Bot Framework call for our app. Route answers 401. */
export class BotAuthError extends Error {}

// ---------------------------------------------------------------- connector.ts

export interface TeamsConnector {
  /** Posts a new activity into a conversation (channel, group chat or 1:1). Returns the new activity id. */
  send(serviceUrl: string, conversationId: string, activity: OutgoingActivity): Promise<{ id: string }>
  /** Replaces an earlier activity (used to update a card after a click). */
  update(serviceUrl: string, conversationId: string, activityId: string, activity: OutgoingActivity): Promise<void>
  /** The Teams member behind from.id, with their email / UPN (no Graph permission needed). */
  member(serviceUrl: string, conversationId: string, userId: string): Promise<TeamsMember>
}

export type TeamsMember = { email: string | null; name: string | null; aadObjectId: string | null }

// ---------------------------------------------------------------- store.ts

export type TeamsChannelRef = { id: string; name: string | null }

/** settings key 'teams_channels' (JSON). One channel per Senior Accountant (by vas.va_id) plus Escalations. */
export type TeamsChannelMap = {
  serviceUrl: string
  tenantId: string
  teamId: string | null
  accountants: Record<string, TeamsChannelRef> // key: vas.va_id
  escalations: TeamsChannelRef | null
}

/**
 * settings key 'teams_personal' (JSON): each person's 1:1 chat with Shadow, by login email (lower case). Saved by the
 * bot when someone opens the Shadow chat or messages it. Cards go here first (lib/teams/routing.ts); a linked channel
 * is only the fallback.
 */
export type PersonalChat = { conversationId: string; serviceUrl: string; name: string | null; at: string }
export type PersonalChats = Record<string, PersonalChat>

/** Where a card is posted: a 1:1 chat or a channel. */
export type DeliveryTarget = { id: string; name: string | null; serviceUrl: string }

export type NotificationKind = 'ticket' | 'reminder' | 'escalation' | 'files'
export type NotificationAction = 'started' | 'closed' | 'not_ticket' | 'reassigned' | 'pinged'

export type NotificationRow = {
  kind: NotificationKind
  ref_id: string
  client_id: string | null
  channel_id: string
  activity_id: string | null
  sent_at: string
  action: NotificationAction | null
  action_by: string | null
  action_at: string | null
}

/** One ticket with what a card needs. */
export type TicketForCard = {
  id: string
  clientId: string
  clientName: string
  title: string | null
  summary: string
  tag: string | null
  status: string // 'open' | 'closed'
  openedAt: string
  lastMessageAt: string
  lastMessageDirection: string | null // 'incoming' | 'outgoing'
  vaId: string | null // conversations.va_id, else clients.va_id
  vaName: string | null
  slaBreached: boolean
}

export interface TeamsStore {
  channels(): Promise<TeamsChannelMap | null>
  saveChannels(map: TeamsChannelMap): Promise<void>
  /** Everyone's 1:1 chat with Shadow ({} when none). */
  personalChats(): Promise<PersonalChats>
  /** Saves (or replaces) one person's 1:1 chat. */
  savePersonalChat(email: string, chat: PersonalChat): Promise<void>
  /** ref_ids of this kind that already have a row. */
  sentRefs(kind: NotificationKind, refIds: string[]): Promise<Set<string>>
  /** Inserts one row. false when (kind, ref_id) already exists (another run sent it): caller must not send again. */
  claim(row: { kind: NotificationKind; ref_id: string; client_id: string | null; channel_id: string }): Promise<boolean>
  /** Releases a claim whose send failed, so the next run retries it. */
  release(kind: NotificationKind, refId: string): Promise<void>
  /** Saves the posted card's activity id; channelId also moves the row to that chat (the first target failed). */
  setActivityId(kind: NotificationKind, refId: string, activityId: string, channelId?: string): Promise<void>
  get(kind: NotificationKind, refId: string): Promise<NotificationRow | null>
  recordAction(kind: NotificationKind, refId: string, action: NotificationAction, by: string, at: string): Promise<void>
  /** The ticket for a card, or null when it does not exist. No user scoping: callers check access first. */
  ticketForCard(ticketId: string): Promise<TicketForCard | null>
  /** Senior Accountants for the Reassign picker. */
  accountants(): Promise<{ vaId: string; name: string; email: string | null; teamsUserId: string | null }[]>
}

// ---------------------------------------------------------------- cards.ts

export type CardActionName = 'start' | 'close' | 'not_ticket' | 'reassign' | 'ping'

/**
 * data of every Action.Execute (verb 'ticket'). `kind` + `ref` name the teams_notifications row of the card that
 * was clicked (so the click is recorded on it and the card can be updated). For reassign the chosen va_id
 * arrives as `vaId` (Input.ChoiceSet id 'vaId').
 */
export type CardActionData = { action: CardActionName; ticketId: string; kind: NotificationKind; ref: string; vaId?: string }

/** Shown on a card after someone acted on it, instead of the buttons. */
export type CardHandled = { action: NotificationAction; by: string; at: string; note?: string }

// ---------------------------------------------------------------- identity.ts / AI

export type ResolveUser = (email: string) => Promise<AppUser | null>

export type AskShadow = (
  user: AppUser,
  question: string,
  o?: { history?: ChatTurn[]; teams?: boolean },
) => Promise<{ text: string; citations: { n: number; label: string; link?: string }[]; save?: SaveProposal; closes?: string[] }>
