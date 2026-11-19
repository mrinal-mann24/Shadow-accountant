// Shadow Teams bot: handles one Bot Framework activity (card clicks, commands, AI questions, install).
// Every dependency is injected (see BotDeps) so this file has no I/O of its own and is fully unit tested.
// The route (app/api/teams/messages) verifies the JWT first and builds the real deps.
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'
import type { FollowUpAction, FollowUpCardData, FollowUpView } from '@/lib/followups/types'
import {
  cardAttachment,
  escalationCard,
  followUpCard,
  followUpRefParts,
  formatIst,
  helpCard,
  parseCardAction,
  parseFollowUpAction,
  parseSaveAction,
  reminderCard,
  SAVE_VERB,
  saveCard,
  ticketCard,
  type FollowUpHandled,
} from './cards'
import {
  cleanLongText,
  historyTurns,
  MAX_MESSAGE_CHARS,
  MEMORY_TURNS,
  MEMORY_WINDOW_MS,
  NEW_CHAT,
  pendingExpired,
  textToSave,
  type ChatRow,
  type PendingSave,
  type TeamsChatStore,
} from './chat'
import type { SaveTranscriptInput } from '@/lib/data/transcripts'
import { maskCredentials } from '@/lib/ai/redact'
import type {
  Activity,
  AdaptiveCard,
  AskShadow,
  CardActionData,
  CardHandled,
  DeliveryTarget,
  PersonalChat,
  NotificationAction,
  NotificationKind,
  OutgoingActivity,
  ResolveUser,
  TeamsChannelMap,
  TeamsConnector,
  TeamsMember,
  TeamsStore,
  TicketForCard,
} from './types'

export type BotTicket = { id: string; clientId: string; vaId: string | null; status: string }

export type BotData = {
  /** lib/data updateConversation: senior_accountant (own clients) or admin. Throws ForbiddenError / 'Ticket not found.' */
  updateConversation: (user: AppUser, id: string, patch: { status: 'closed' }) => Promise<void>
  /** The ticket when the user may see it, else null. */
  ticketForUser: (user: AppUser, id: string) => Promise<BotTicket | null>
  /** Admin only. */
  reassignTicket: (user: AppUser, id: string, vaId: string) => Promise<void>
}

export type BotFollowUps = {
  /**
   * lib/data followUpAction: senior_accountant (own clients) or admin. Throws ForbiddenError (also while viewing as
   * someone), 'Follow-up not found.', 'This follow-up is already closed.' or 'Only promises and document requests
   * can be extended.'
   */
  action: (user: AppUser, id: string, action: FollowUpAction, now?: Date) => Promise<FollowUpView>
}

export type BotDeps = {
  connector: TeamsConnector
  store: TeamsStore
  resolveUser: ResolveUser
  ask: AskShadow
  data: BotData
  followUps: BotFollowUps
  /** 1:1 chat memory and pending saves (table teams_chat). */
  chat: TeamsChatStore
  /** lib/data saveClientTranscript: checks the user's access to the client again. */
  saveTranscript: (user: AppUser, input: SaveTranscriptInput) => Promise<{ id: string }>
  siteUrl: string
  tenantId: string
  now?: () => Date
  /** Runs work after the HTTP response (Next `after`). */
  defer: (task: () => Promise<void>) => void
}

export type BotReply = { status: number; body?: unknown }

export const NOT_SET_UP = 'Your Teams account is not set up in Shadow yet. Ask an Admin to add you.'
export const REFUSAL = 'You cannot do this for this client.'
export const AI_FAILED = 'Sorry, I could not answer that right now.'
/** Longest 1:1 message read (a pasted transcript). */
export const MAX_QUESTION = MAX_MESSAGE_CHARS
export const NEW_CHAT_DONE = 'Started a new chat. I have forgotten our earlier messages.'
export const NOTHING_TO_SAVE = 'I could not find the text to save. Paste the transcript or notes in one message and say which client.'
export const SAVE_FAILED = 'Sorry, I could not save that right now. Please try again.'
export const SAVE_GONE = 'This was already saved or cancelled.'
export const SAVE_EXPIRED = 'This save request has expired. Paste the text again and ask me to save it.'
export const NO_ACCOUNTANT_CHAT = 'This accountant has not opened the Shadow chat in Teams yet. Ask them to open Shadow and say hi.'

export const DIRECT_ONLY =
  'To ask about your clients, message me directly (1:1 chat). I do not answer questions in shared channels.'
export const TOO_MANY = 'You have asked a lot of questions in a short time. Please try again in a few minutes.'
export const ALREADY_DONE = 'Already done.'
export const ALREADY_CLOSED = 'This ticket is already closed.'
export const OTHER_TEAM = 'Shadow is linked to another team. Unlink all channels there first.'
export const INVALID_CARD = 'This card action is not valid.'
export const PING_FAILED = 'Could not post the reminder to the accountant channel. Please try again.'
export const FOLLOW_UP_CLOSED = 'This follow-up is already closed.'
export const FOLLOW_UP_NOT_FOUND = 'This follow-up was not found. It may have been removed.'
export const FOLLOW_UP_NO_EXTEND = 'Only promises and document requests can be extended.'

const NOT_FOUND = 'This ticket was not found. It may have been removed.'
const FAILED = 'Sorry, that did not work. Please try again from Shadow.'
const LOOKUP_FAILED = 'Sorry, I could not check your Teams account right now. Please try again.'

const ACTION_DONE: Record<CardActionData['action'], NotificationAction> = {
  start: 'started',
  close: 'closed',
  not_ticket: 'not_ticket',
  reassign: 'reassigned',
  ping: 'pinged',
}

// ---------------------------------------------------------------- per-instance memory
// Best effort, per server instance: every serverless instance has its own memory and loses it on a cold start, so a
// retry or a burst that lands on another instance is not caught. This is enough to absorb Teams retries of the same
// activity (they usually reach the same warm instance), slow down a question loop and skip repeated lookups.
// Every map is bounded: the oldest entry is dropped when it is full.

export const DEDUP_TTL_MS = 10 * 60_000
export const DEDUP_MAX = 2000
export const QUESTION_WINDOW_MS = 10 * 60_000
export const MAX_QUESTIONS = 10
export const MEMBER_TTL_MS = 10 * 60_000
const MAP_MAX = 2000

/** activity key -> when it was first handled (ms). */
const handledActivities = new Map<string, number>()
/** email -> times of AI questions in the window (ms). */
const questionTimes = new Map<string, number[]>()
/** serviceUrl + aadObjectId (or from.id) -> Teams member. */
const memberCache = new Map<string, { at: number; member: TeamsMember }>()

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value as string)
}

/** Clears the de-duplication, rate limit and member caches (tests). */
export function resetBotState(): void {
  handledActivities.clear()
  questionTimes.clear()
  memberCache.clear()
  knownChats.clear()
}

function nowMs(deps: BotDeps): number {
  return (deps.now ?? (() => new Date()))().getTime()
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Runs work after the response; errors are logged with their message only. */
function later(deps: BotDeps, label: string, task: () => Promise<unknown>): void {
  deps.defer(async () => {
    try {
      await task()
    } catch (e) {
      console.error(`[teams-bot] ${label} failed:`, errorMessage(e))
    }
  })
}

/** Handles an activity id once per DEDUP_TTL_MS; a repeat gets `repeat`. A run that throws is forgotten. */
async function once(activity: Activity, deps: BotDeps, repeat: BotReply, run: () => Promise<BotReply>): Promise<BotReply> {
  if (!activity.id) return run()
  const key = `${activity.type}|${baseConversationId(activity.conversation.id)}|${activity.id}`
  const t = nowMs(deps)
  const seen = handledActivities.get(key)
  if (seen !== undefined && t - seen < DEDUP_TTL_MS) return repeat
  remember(handledActivities, key, t, DEDUP_MAX)
  try {
    return await run()
  } catch (e) {
    handledActivities.delete(key)
    throw e
  }
}

/** True when this email may ask another AI question now (MAX_QUESTIONS per QUESTION_WINDOW_MS). */
function allowQuestion(email: string, t: number): boolean {
  const key = email.trim().toLowerCase()
  const recent = (questionTimes.get(key) ?? []).filter((at) => t - at < QUESTION_WINDOW_MS)
  const ok = recent.length < MAX_QUESTIONS
  if (ok) recent.push(t)
  remember(questionTimes, key, recent, MAP_MAX)
  return ok
}

// ---------------------------------------------------------------- helpers

/** The activity's tenant (channelData.tenant.id, else conversation.tenantId). */
export function activityTenant(a: Activity): string | null {
  return a.channelData?.tenant?.id ?? a.conversation?.tenantId ?? null
}

/** A channel conversation id without the ';messageid=...' thread suffix. */
export function baseConversationId(id: string): string {
  return id.split(';')[0]
}

/** Message text with <at>...</at> mentions and any other markup removed, spaces collapsed and trimmed. */
export function cleanText(text: string | undefined): string {
  return (text ?? '')
    .replace(/<at[^>]*>[\s\S]*?<\/at>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function invokeMessage(message: string): BotReply {
  return { status: 200, body: { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: message } }
}

function invokeBadRequest(message: string): BotReply {
  return {
    status: 200,
    body: { statusCode: 400, type: 'application/vnd.microsoft.error', value: { code: 'BadRequest', message } },
  }
}

function invokeCard(card: AdaptiveCard): BotReply {
  return { status: 200, body: { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card } }
}

function plain(text: string): OutgoingActivity {
  return { type: 'message', text, textFormat: 'markdown' }
}

/** Friendly text for an error from a data function. Never a stack trace or a raw database message. */
function friendlyError(e: unknown): string {
  if (e instanceof ForbiddenError) return REFUSAL
  if (e instanceof Error && /not found/i.test(e.message)) return NOT_FOUND
  console.error('[teams-bot] action failed:', e instanceof Error ? e.message : String(e))
  return FAILED
}

function waitingMinutes(t: TicketForCard, now: Date): number {
  const at = Date.parse(t.lastMessageAt)
  if (Number.isNaN(at)) return 0
  return Math.max(0, Math.floor((now.getTime() - at) / 60_000))
}

/** Absolute link for a citation: relative links are joined to siteUrl. */
export function absoluteLink(siteUrl: string, link: string): string {
  if (/^https?:\/\//i.test(link)) return link
  const base = siteUrl.replace(/\/+$/, '')
  return `${base}${link.startsWith('/') ? '' : '/'}${link}`
}

/** AI answer as markdown with a numbered Sources list. */
export function formatAnswer(
  siteUrl: string,
  r: { text: string; citations: { n: number; label: string; link?: string }[] },
): string {
  const text = r.text.trim()
  if (r.citations.length === 0) return text
  const lines = r.citations.map((c) => {
    const label = c.label.replace(/[[\]\r\n]/g, ' ').trim() || `Source ${c.n}`
    if (!c.link) return `${c.n}. ${label}`
    const url = absoluteLink(siteUrl, c.link).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
    return `${c.n}. [${label}](${url})`
  })
  return `${text}\n\n**Sources**\n\n${lines.join('\n')}`
}

type Who = { kind: 'user'; user: AppUser; email: string } | { kind: 'unknown' } | { kind: 'failed' }

/** Guest (B2B) accounts carry '#EXT#' in their UPN. They are never set up. */
function isGuest(email: string): boolean {
  return /#EXT#/i.test(email)
}

async function memberOf(activity: Activity, deps: BotDeps): Promise<TeamsMember> {
  const key = `${activity.serviceUrl}|${activity.from.aadObjectId || activity.from.id}`
  const t = nowMs(deps)
  const hit = memberCache.get(key)
  if (hit && t - hit.at < MEMBER_TTL_MS) return hit.member
  const member = await deps.connector.member(activity.serviceUrl, baseConversationId(activity.conversation.id), activity.from.id)
  remember(memberCache, key, { at: t, member }, MAP_MAX)
  return member
}

async function identify(activity: Activity, deps: BotDeps): Promise<Who> {
  try {
    const m = await memberOf(activity, deps)
    const email = m.email?.trim()
    if (!email || isGuest(email)) return { kind: 'unknown' }
    const user = await deps.resolveUser(email)
    return user ? { kind: 'user', user, email } : { kind: 'unknown' }
  } catch (e) {
    console.error('[teams-bot] member lookup failed:', errorMessage(e))
    return { kind: 'failed' }
  }
}

type AccountantDest = {
  target: DeliveryTarget
  /** True for the accountant's 1:1 chat (no @mention needed), false for their linked channel. */
  personal: boolean
  accountant: Awaited<ReturnType<TeamsStore['accountants']>>[number] | undefined
}

/** The accountant's 1:1 chat with Shadow (by their vas email), else their linked channel, else null. */
async function accountantTarget(deps: BotDeps, vaId: string): Promise<AccountantDest | null> {
  const [accountants, chats, map] = await Promise.all([deps.store.accountants(), deps.store.personalChats(), deps.store.channels()])
  const accountant = accountants.find((a) => a.vaId === vaId)
  const email = accountant?.email?.trim().toLowerCase()
  const chat = email ? chats[email] : undefined
  if (chat) return { target: { id: chat.conversationId, name: accountant?.name ?? null, serviceUrl: chat.serviceUrl }, personal: true, accountant }
  const channel = map?.accountants[vaId]
  if (map && channel) return { target: { id: channel.id, name: channel.name, serviceUrl: map.serviceUrl }, personal: false, accountant }
  return null
}

/** email -> 'conversationId|serviceUrl' already saved by this server instance, so a known chat costs no reads. */
const knownChats = new Map<string, string>()

/** What a person gets in their 1:1 chat, by role. Shown once, when Shadow first learns their chat. */
export function setupLine(user: AppUser): string {
  if (user.role === 'senior_accountant') {
    return "You are set up. I will send you new tickets, reminders, client files and follow-ups for your clients here. Ask me anything about them, or type help."
  }
  return 'You are set up. I will send you escalations (clients waiting too long, repeat asks, missed promises) here. Ask me anything about any client, or type help.'
}

/**
 * Saves the person's 1:1 chat with Shadow (settings 'teams_personal') when it is new or has changed, so cards can be
 * sent to them. Returns true the first time. Best effort: a failure is logged and the chat is tried again next time.
 */
async function rememberPersonalChat(activity: Activity, deps: BotDeps, email: string, user: AppUser): Promise<boolean> {
  if (activity.conversation.conversationType !== 'personal') return false
  const key = email.trim().toLowerCase()
  const value = `${activity.conversation.id}|${activity.serviceUrl}`
  if (knownChats.get(key) === value) return false
  const matches = (c: PersonalChat | undefined) =>
    !!c && c.conversationId === activity.conversation.id && c.serviceUrl === activity.serviceUrl
  try {
    const existing = (await deps.store.personalChats())[key]
    const isNew = !existing
    if (!matches(existing)) {
      const chat: PersonalChat = {
        conversationId: activity.conversation.id,
        serviceUrl: activity.serviceUrl,
        name: user.name,
        at: (deps.now ?? (() => new Date()))().toISOString(),
      }
      // The settings write is read-modify-write: another person registering at the same moment can overwrite it.
      // Read it back and write once more if it is missing; only a confirmed chat is cached as known.
      await deps.store.savePersonalChat(key, chat)
      if (!matches((await deps.store.personalChats())[key])) {
        await deps.store.savePersonalChat(key, chat)
        if (!matches((await deps.store.personalChats())[key])) return isNew // tried again on the next message
      }
    }
    remember(knownChats, key, value, MAP_MAX)
    return isNew
  } catch (e) {
    console.error('[teams-bot] save personal chat failed:', errorMessage(e))
    return false
  }
}

/** When the linked team now arrives on another serviceUrl (region move), store the new one so posting keeps working. */
function refreshServiceUrl(activity: Activity, deps: BotDeps): void {
  const teamId = activity.channelData?.team?.id
  if (!teamId) return
  later(deps, 'serviceUrl refresh', async () => {
    const map = await deps.store.channels()
    if (!map || map.teamId !== teamId || map.serviceUrl === activity.serviceUrl) return
    await deps.store.saveChannels({ ...map, serviceUrl: activity.serviceUrl })
  })
}

// ---------------------------------------------------------------- entry

export async function handleActivity(activity: Activity, deps: BotDeps): Promise<BotReply> {
  if (activityTenant(activity) !== deps.tenantId) return { status: 403 }
  refreshServiceUrl(activity, deps)

  if (activity.type === 'invoke') {
    if (activity.name !== 'adaptiveCard/action') return { status: 200 }
    return once(activity, deps, invokeMessage(ALREADY_DONE), () => handleCardAction(activity, deps))
  }
  if (activity.type === 'message') return once(activity, deps, { status: 200 }, () => handleMessage(activity, deps))
  if (activity.type === 'conversationUpdate') {
    const botId = activity.recipient?.id
    if (botId && (activity.membersAdded ?? []).some((m) => m.id === botId)) {
      await deps.connector.send(activity.serviceUrl, activity.conversation.id, cardAttachment(helpCard({ siteUrl: deps.siteUrl })))
      // Installed in someone's 1:1 chat (by them or by an Admin policy): remember it, so cards can reach them.
      if (activity.conversation.conversationType === 'personal') {
        const who = await identify(activity, deps)
        if (who.kind === 'user' && (await rememberPersonalChat(activity, deps, who.email, who.user))) {
          await deps.connector.send(activity.serviceUrl, activity.conversation.id, plain(setupLine(who.user)))
        }
      }
    }
    return { status: 200 }
  }
  return { status: 200 }
}

// ---------------------------------------------------------------- card clicks

/** The card's ref must belong to its ticket: the ticket id itself, or '<ticketId>@...' (reminder / escalation). */
function refMatchesTicket(data: CardActionData): boolean {
  return data.ref === data.ticketId || data.ref.startsWith(`${data.ticketId}@`)
}

// Teams waits about 15 s for an invoke answer. The data change (close, reassign, record) happens before the answer;
// posts to other channels and refreshing stored card copies run after it (deps.defer).
async function handleCardAction(activity: Activity, deps: BotDeps): Promise<BotReply> {
  if (isFollowUpVerb(activity.value)) return handleFollowUpAction(activity, deps)
  if (isSaveVerb(activity.value)) return handleSaveAction(activity, deps)
  const data = parseCardAction(activity.value)
  if (!data || !refMatchesTicket(data)) return invokeBadRequest(INVALID_CARD)

  const who = await identify(activity, deps)
  if (who.kind === 'unknown') return invokeMessage(NOT_SET_UP)
  if (who.kind === 'failed') return invokeMessage(LOOKUP_FAILED)
  const { user, email } = who
  const now = (deps.now ?? (() => new Date()))()
  const at = now.toISOString()
  const action = ACTION_DONE[data.action]
  const isPing = data.action === 'ping'
  let note: string | undefined

  try {
    switch (data.action) {
      case 'start': {
        if (user.role !== 'senior_accountant' && user.role !== 'admin') return invokeMessage(REFUSAL)
        const t = await deps.data.ticketForUser(user, data.ticketId)
        if (!t) return invokeMessage(REFUSAL)
        if (t.status === 'closed') return invokeMessage(ALREADY_CLOSED)
        break
      }
      case 'close':
      case 'not_ticket': {
        // A second click (another card copy, or a stale card) must not close again: that would overwrite
        // closed_at and record a second, misleading action.
        const t = await deps.data.ticketForUser(user, data.ticketId)
        if (!t) return invokeMessage(REFUSAL)
        if (t.status === 'closed') return invokeMessage(ALREADY_CLOSED)
        await deps.data.updateConversation(user, data.ticketId, { status: 'closed' })
        break
      }
      case 'reassign': {
        if (user.role !== 'admin') return invokeMessage(REFUSAL)
        if (!data.vaId) return invokeMessage('Pick an accountant to reassign to.')
        const accountants = await deps.store.accountants()
        const target = accountants.find((a) => a.vaId === data.vaId)
        if (!target) return invokeMessage('That accountant was not found.')
        const current = await deps.data.ticketForUser(user, data.ticketId)
        if (!current) return invokeMessage(REFUSAL)
        if (current.vaId === data.vaId) return invokeMessage(`This ticket is already with ${target.name}.`)
        await deps.data.reassignTicket(user, data.ticketId, data.vaId)
        note = `Reassigned to ${target.name}`
        const dest = await accountantTarget(deps, data.vaId)
        if (!dest) {
          note += ' (they have not opened the Shadow chat in Teams yet)'
        } else {
          const ticketId = data.ticketId
          later(deps, 'reassign post', async () => {
            const t = await deps.store.ticketForCard(ticketId)
            if (t) await deps.connector.send(dest.target.serviceUrl, dest.target.id, cardAttachment(ticketCard(t, { siteUrl: deps.siteUrl })))
          })
        }
        break
      }
      case 'ping': {
        if (user.role !== 'admin') return invokeMessage(REFUSAL)
        const t = await deps.store.ticketForCard(data.ticketId)
        if (!t) return invokeMessage(NOT_FOUND)
        const dest = t.vaId ? await accountantTarget(deps, t.vaId) : null
        if (!dest) return invokeMessage(NO_ACCOUNTANT_CHAT)
        const acc = dest.accountant
        // Its own ref, so clicks on this reminder are not recorded on the real reminder row.
        const card = reminderCard(t, { siteUrl: deps.siteUrl, waitingMinutes: waitingMinutes(t, now), ref: `${data.ref}#ping` })
        const out: OutgoingActivity = cardAttachment(card)
        if (dest.personal) {
          out.text = 'An Admin asked you to pick this up.'
        } else if (acc?.teamsUserId) {
          const name = acc.name.replace(/[<>]/g, '')
          const mention = `<at>${name}</at>`
          out.text = `${mention} please pick this up`
          out.entities = [{ type: 'mention', text: mention, mentioned: { id: acc.teamsUserId, name } }]
        }
        const by = user.name
        later(deps, 'ping post', async () => {
          let reply = `Accountant pinged by ${by}`
          try {
            await deps.connector.send(dest.target.serviceUrl, dest.target.id, out)
          } catch (e) {
            console.error('[teams-bot] ping post failed:', errorMessage(e))
            reply = PING_FAILED
          }
          await deps.connector.send(activity.serviceUrl, activity.conversation.id, plain(reply))
        })
        break
      }
    }
  } catch (e) {
    return invokeMessage(friendlyError(e))
  }

  // Record the click on the card that was clicked, and on the ticket card (ping only marks the escalation).
  const rows: { kind: NotificationKind; ref: string }[] = [{ kind: data.kind, ref: data.ref }]
  const isTicketRow = data.kind === 'ticket' && data.ref === data.ticketId
  if (!isPing && !isTicketRow) rows.push({ kind: 'ticket', ref: data.ticketId })
  for (const r of rows) {
    try {
      await deps.store.recordAction(r.kind, r.ref, action, email, at)
    } catch (e) {
      console.error('[teams-bot] recordAction failed:', errorMessage(e))
    }
  }

  const t = await deps.store.ticketForCard(data.ticketId)
  if (!t) return invokeMessage('Done.')
  // A ping leaves the escalation open, so its card keeps the buttons (the note is posted as a reply instead).
  const handled: CardHandled | undefined = isPing ? undefined : { action, by: user.name, at, ...(note ? { note } : {}) }
  let accountants: { vaId: string; name: string }[] | null = null
  const build = async (kind: NotificationKind, ref: string): Promise<AdaptiveCard> => {
    if (kind === 'reminder') return reminderCard(t, { siteUrl: deps.siteUrl, waitingMinutes: waitingMinutes(t, now), ref, handled })
    if (kind === 'escalation') {
      accountants ??= await deps.store.accountants()
      return escalationCard(t, { siteUrl: deps.siteUrl, waitingMinutes: waitingMinutes(t, now), ref, accountants, handled })
    }
    return ticketCard(t, { siteUrl: deps.siteUrl, handled })
  }

  const clicked = await build(data.kind, data.ref)
  // Best effort, after the answer: refresh the stored copies of the cards (other viewers, and the ticket card in the
  // accountant channel). A ping changes nothing on them.
  if (!isPing) {
    later(deps, 'card update', async () => {
      for (const r of rows) {
        try {
          const row = await deps.store.get(r.kind, r.ref)
          if (!row?.activity_id) continue
          const card = r.kind === data.kind && r.ref === data.ref ? clicked : await build(r.kind, r.ref)
          await deps.connector.update(activity.serviceUrl, row.channel_id, row.activity_id, cardAttachment(card))
        } catch (e) {
          console.error('[teams-bot] card update failed:', errorMessage(e))
        }
      }
    })
  }
  return invokeCard(clicked)
}

// ---------------------------------------------------------------- follow-up card clicks

function isFollowUpVerb(value: unknown): boolean {
  const action = (value as { action?: { verb?: unknown } } | null)?.action
  return typeof action === 'object' && action !== null && action.verb === 'followup'
}

const FOLLOW_UP_HANDLED: Record<FollowUpAction, FollowUpHandled['action']> = {
  done: 'done',
  cancel: 'cancelled',
  extend: 'extended',
}

/** Friendly text for an error from followUpAction. Never a stack trace or a raw database message. */
function followUpError(e: unknown): string {
  if (e instanceof ForbiddenError) return REFUSAL
  const message = e instanceof Error ? e.message : ''
  if (/already closed/i.test(message)) return FOLLOW_UP_CLOSED
  if (/not found/i.test(message)) return FOLLOW_UP_NOT_FOUND
  if (/can be extended/i.test(message)) return FOLLOW_UP_NO_EXTEND
  console.error('[teams-bot] follow-up action failed:', message || String(e))
  return FAILED
}

// The follow_ups row is the record of the click (resolved_by / status), so nothing is written to teams_notifications.
// The answer is the rebuilt card; the stored copy (other viewers) is refreshed after the answer, best effort.
async function handleFollowUpAction(activity: Activity, deps: BotDeps): Promise<BotReply> {
  const data: FollowUpCardData | null = parseFollowUpAction(activity.value)
  const parts = data ? followUpRefParts(data.ref, data.followUpId) : null
  if (!data || !parts) return invokeBadRequest(INVALID_CARD)

  const who = await identify(activity, deps)
  if (who.kind === 'unknown') return invokeMessage(NOT_SET_UP)
  if (who.kind === 'failed') return invokeMessage(LOOKUP_FAILED)
  const { user } = who
  const now = (deps.now ?? (() => new Date()))()

  let view: FollowUpView
  try {
    view = await deps.followUps.action(user, data.followUpId, data.action, now)
  } catch (e) {
    return invokeMessage(followUpError(e))
  }

  const due = data.action === 'extend' ? formatIst(view.dueAt) : ''
  const handled: FollowUpHandled = {
    action: FOLLOW_UP_HANDLED[data.action],
    by: user.name,
    at: now.toISOString(),
    ...(due ? { note: `New due date: ${due}` } : {}),
  }
  const card = followUpCard(view, { siteUrl: deps.siteUrl, what: parts.what, ref: data.ref, kind: data.kind, handled, now })
  later(deps, 'follow-up card update', async () => {
    const row = await deps.store.get(data.kind, data.ref)
    if (!row?.activity_id) return
    await deps.connector.update(activity.serviceUrl, row.channel_id, row.activity_id, cardAttachment(card))
  })
  return invokeCard(card)
}

// ---------------------------------------------------------------- messages

const LINK_ESCALATIONS = /^link\s+escalations$/i
const LINK_EMAIL = /^link\s+(\S+@\S+)$/i
const UNLINK = /^unlink$/i
const CHANNELS = /^channels$/i

async function handleMessage(activity: Activity, deps: BotDeps): Promise<BotReply> {
  const reply = (out: OutgoingActivity) => deps.connector.send(activity.serviceUrl, activity.conversation.id, out)
  const text = cleanText(activity.text)

  const who = await identify(activity, deps)
  if (who.kind !== 'user') {
    await reply(plain(who.kind === 'unknown' ? NOT_SET_UP : LOOKUP_FAILED))
    return { status: 200 }
  }
  const { user, email } = who
  // First message in a 1:1 chat: remember it, so tickets and alerts can be sent here.
  if (await rememberPersonalChat(activity, deps, email, user)) await reply(plain(setupLine(user)))

  if (text === '' || /^help$/i.test(text)) {
    await reply(cardAttachment(helpCard({ siteUrl: deps.siteUrl })))
    return { status: 200 }
  }

  if (LINK_ESCALATIONS.test(text) || LINK_EMAIL.test(text) || UNLINK.test(text) || CHANNELS.test(text)) {
    await reply(plain(await channelCommand(text, activity, deps, user)))
    return { status: 200 }
  }

  // Privacy: answers can name any client the user may see, so they are only given in a 1:1 chat.
  if (activity.conversation.conversationType !== 'personal') {
    await reply(plain(DIRECT_ONLY))
    return { status: 200 }
  }
  if (!allowQuestion(email, nowMs(deps))) {
    await reply(plain(TOO_MANY))
    return { status: 200 }
  }

  if (NEW_CHAT.test(text)) {
    try {
      await deps.chat.clear(email)
      await reply(plain(NEW_CHAT_DONE))
    } catch (e) {
      console.error('[teams-bot] chat clear failed:', errorMessage(e))
      await reply(plain(FAILED))
    }
    return { status: 200 }
  }

  // Keep line breaks: a pasted transcript must be saved as it was sent. Credentials are masked before anything is
  // stored (memory, pending save) or sent to the model (CLAUDE.md: never store client passwords).
  const message = maskCredentials(cleanLongText(activity.text).slice(0, MAX_QUESTION) || text)
  const now = (deps.now ?? (() => new Date()))()
  deps.defer(async () => {
    let history: ChatRow[] = []
    try {
      history = await deps.chat.recentTurns(email, new Date(now.getTime() - MEMORY_WINDOW_MS).toISOString(), MEMORY_TURNS)
    } catch (e) {
      console.error('[teams-bot] chat memory read failed:', errorMessage(e)) // answer without memory
    }
    // The user turn is kept even when the AI then fails, so "save that" still finds a pasted transcript.
    try {
      await deps.chat.addTurns(email, [{ kind: 'user', content: message }])
    } catch (e) {
      console.error('[teams-bot] chat memory write failed:', errorMessage(e))
    }

    let out: string
    let answerText = ''
    let card: AdaptiveCard | null = null
    try {
      const r = await deps.ask(user, message, { history: historyTurns(history), teams: true })
      answerText = r.text
      out = formatAnswer(deps.siteUrl, r)
      if (r.save) {
        const content = textToSave(r.save, message, history)
        if (!content) {
          out += `\n\n${NOTHING_TO_SAVE}`
        } else {
          const meta = { clientId: r.save.clientId, clientName: r.save.clientName, title: r.save.title, meetingDate: r.save.meetingDate }
          try {
            const pendingId = await deps.chat.addPending(email, content, meta)
            card = saveCard({ pendingId, ...meta, content }, { siteUrl: deps.siteUrl })
          } catch (e) {
            console.error('[teams-bot] pending save failed:', errorMessage(e))
            out += `\n\n${SAVE_FAILED}`
          }
        }
      }
    } catch (e) {
      console.error('[teams-bot] ask failed:', errorMessage(e))
      out = AI_FAILED
    }
    await reply(plain(out))
    if (card) await reply(cardAttachment(card))
    if (answerText) {
      try {
        await deps.chat.addTurns(email, [{ kind: 'assistant', content: answerText }])
      } catch (e) {
        console.error('[teams-bot] chat memory write failed:', errorMessage(e))
      }
    }
  })
  return { status: 200 }
}

// ---------------------------------------------------------------- save card clicks

function isSaveVerb(value: unknown): boolean {
  const action = (value as { action?: { verb?: unknown } } | null)?.action
  return typeof action === 'object' && action !== null && action.verb === SAVE_VERB
}

function saveError(e: unknown): string {
  if (e instanceof ViewAsReadOnlyError) return e.message
  if (e instanceof ForbiddenError) return REFUSAL
  console.error('[teams-bot] save failed:', errorMessage(e))
  return SAVE_FAILED
}

// Only the person who asked can press Save (the pending row is looked up by their email). The row is taken (deleted)
// before saving, so a second click finds nothing; when the save itself fails the text is kept as a new pending row
// and the answer is a fresh card to try again.
async function handleSaveAction(activity: Activity, deps: BotDeps): Promise<BotReply> {
  const data = parseSaveAction(activity.value)
  if (!data) return invokeBadRequest(INVALID_CARD)
  const who = await identify(activity, deps)
  if (who.kind === 'unknown') return invokeMessage(NOT_SET_UP)
  if (who.kind === 'failed') return invokeMessage(LOOKUP_FAILED)
  const { user, email } = who
  const now = (deps.now ?? (() => new Date()))()
  const at = now.toISOString()

  let pending: PendingSave | null
  try {
    pending = await deps.chat.takePending(data.pendingId, email)
  } catch (e) {
    console.error('[teams-bot] take pending failed:', errorMessage(e))
    return invokeMessage(SAVE_FAILED)
  }
  if (!pending) return invokeMessage(SAVE_GONE)
  const view = { pendingId: pending.id, ...pending.meta, content: pending.content }

  if (data.action === 'cancel') return invokeCard(saveCard(view, { siteUrl: deps.siteUrl, handled: { action: 'cancelled', by: user.name, at } }))
  if (pendingExpired(pending, now)) return invokeMessage(SAVE_EXPIRED)

  try {
    await deps.saveTranscript(user, {
      clientId: pending.meta.clientId,
      title: pending.meta.title,
      meetingDate: pending.meta.meetingDate,
      transcript: pending.content,
      now,
    })
  } catch (e) {
    const message = saveError(e)
    if (e instanceof ForbiddenError) return invokeMessage(message)
    try {
      const retryId = await deps.chat.addPending(email, pending.content, pending.meta)
      return invokeCard(saveCard({ ...view, pendingId: retryId }, { siteUrl: deps.siteUrl }))
    } catch {
      return invokeMessage(message)
    }
  }
  return invokeCard(
    saveCard(view, {
      siteUrl: deps.siteUrl,
      handled: { action: 'saved', by: user.name, at, note: 'It now shows under Meetings on the client page and in Ask Shadow.' },
    }),
  )
}

/** Removes a channel from every target. True when it was linked anywhere. */
function removeChannel(map: TeamsChannelMap, channelId: string): boolean {
  let removed = false
  if (map.escalations?.id === channelId) {
    map.escalations = null
    removed = true
  }
  for (const [vaId, ref] of Object.entries(map.accountants)) {
    if (ref.id === channelId) {
      delete map.accountants[vaId]
      removed = true
    }
  }
  return removed
}

async function channelCommand(text: string, activity: Activity, deps: BotDeps, user: AppUser): Promise<string> {
  if (user.role !== 'admin' && user.role !== 'engineer') return 'Only an Admin or Engineer can change channel links.'
  const team = activity.channelData?.team
  if (!team) return 'Type this in a team channel, not in a chat.'
  const channelId = baseConversationId(activity.conversation.id)
  const channelName = activity.channelData?.channel?.name ?? null
  const accountants = await deps.store.accountants()
  const existing = await deps.store.channels()

  if (CHANNELS.test(text)) {
    if (!existing) return 'No channels are linked yet.'
    const label = (r: { name: string | null } | null | undefined) => (r ? r.name || 'a channel' : 'not linked')
    const lines = [`- Escalations: ${label(existing.escalations)}`]
    const seen = new Set<string>()
    for (const a of accountants) {
      seen.add(a.vaId)
      lines.push(`- ${a.name}: ${label(existing.accountants[a.vaId])}`)
    }
    for (const [vaId, ref] of Object.entries(existing.accountants)) {
      if (!seen.has(vaId)) lines.push(`- ${vaId}: ${label(ref)}`)
    }
    return `**Linked channels**\n\n${lines.join('\n')}`
  }

  // One team only: the channel map has a single serviceUrl and team.
  if (existing?.teamId && existing.teamId !== team.id) return OTHER_TEAM

  const map: TeamsChannelMap = existing
    ? { ...existing, accountants: { ...existing.accountants }, serviceUrl: activity.serviceUrl, teamId: existing.teamId ?? team.id }
    : { serviceUrl: activity.serviceUrl, tenantId: deps.tenantId, teamId: team.id, accountants: {}, escalations: null }

  if (UNLINK.test(text)) {
    if (!removeChannel(map, channelId)) return 'This channel is not linked.'
    // Nothing linked any more: free the team binding so Shadow can be moved to another team.
    if (Object.keys(map.accountants).length === 0 && map.escalations === null) map.teamId = null
    await deps.store.saveChannels(map)
    return 'This channel is unlinked. Nothing more will be posted here.'
  }

  const ref = { id: channelId, name: channelName }
  if (LINK_ESCALATIONS.test(text)) {
    removeChannel(map, channelId)
    map.escalations = ref
    await deps.store.saveChannels(map)
    return 'Escalations will be posted to this channel.'
  }

  const email = (LINK_EMAIL.exec(text)?.[1] ?? '').toLowerCase()
  const acc = accountants.find((a) => (a.email ?? '').trim().toLowerCase() === email)
  if (!acc) return `No Senior Accountant found with the email ${email}.`
  removeChannel(map, channelId)
  map.accountants[acc.vaId] = ref
  await deps.store.saveChannels(map)
  return `Tickets for ${acc.name} will be posted to this channel.`
}
