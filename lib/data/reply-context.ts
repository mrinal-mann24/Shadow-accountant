import 'server-only'
// Read-only context for the "Draft reply" feature: one ticket plus what an accountant would look at before
// replying. Scoped like every other read: the ticket's client must be in the user's scope.
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError } from '@/lib/auth/roles'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getTeamNumbers } from '@/lib/team'
import { CONV_COLS, toConversationItem } from './conversations'
import { DOCUMENT_COLS, toDocumentItem } from './documents'
import { MESSAGE_COLS, toMessageItem } from './messages'
import { canAccessClient, isInvalidInput } from './scope'
import type { ConversationItem, DocumentItem, MessageItem } from './types'

export const REPLY_CONTEXT_LIMITS = {
  ticketMessages: 30,
  recentMessages: 30,
  otherTickets: 10,
  files: 20,
  days: 30,
} as const

export type ReplyContext = {
  ticket: ConversationItem
  clientName: string | null
  /** Messages linked to this ticket, oldest first. */
  ticketMessages: MessageItem[]
  /** The client's newest group messages, oldest first (may overlap ticketMessages). */
  recentMessages: MessageItem[]
  /** The client's other tickets with activity in the last 30 days, newest first. */
  otherTickets: ConversationItem[]
  /** Files received in the last 30 days, newest first. */
  files: DocumentItem[]
}

/**
 * Context for drafting a reply on one ticket. null when the ticket does not exist (or the id is not valid).
 * Throws ForbiddenError when the ticket's client is outside the user's scope.
 */
export async function getReplyContext(user: AppUser, ticketId: string, now = new Date()): Promise<ReplyContext | null> {
  const db = createAdminSupabase()
  const conv = await db.from('conversations').select(CONV_COLS).eq('id', ticketId).maybeSingle()
  if (conv.error) {
    if (isInvalidInput(conv.error)) return null
    throw new Error(`getReplyContext: ${conv.error.message}`)
  }
  if (!conv.data) return null
  const clientId = conv.data.client_id
  if (!(await canAccessClient(db, user, clientId))) throw new ForbiddenError()

  const L = REPLY_CONTEXT_LIMITS
  const since = new Date(now.getTime() - L.days * 86_400_000).toISOString()
  const [team, client, ticketMsgs, recentMsgs, others, files] = await Promise.all([
    getTeamNumbers(),
    db.from('clients').select('client_name').eq('client_id', clientId).maybeSingle(),
    db
      .from('client_messages')
      .select(MESSAGE_COLS)
      .eq('conversation_id', ticketId)
      .eq('client_id', clientId)
      .order('message_timestamp', { ascending: false })
      .limit(L.ticketMessages),
    db
      .from('client_messages')
      .select(MESSAGE_COLS)
      .eq('client_id', clientId)
      .order('message_timestamp', { ascending: false })
      .limit(L.recentMessages),
    db
      .from('conversations')
      .select(CONV_COLS)
      .eq('client_id', clientId)
      .neq('id', ticketId)
      .gte('last_message_at', since)
      .order('last_message_at', { ascending: false })
      .limit(L.otherTickets),
    db
      .from('document_uploads')
      .select(DOCUMENT_COLS)
      .eq('client_id', clientId)
      .gte('uploaded_at', since)
      .order('uploaded_at', { ascending: false })
      .limit(L.files),
  ])
  for (const [name, res] of [
    ['clients', client],
    ['ticket messages', ticketMsgs],
    ['recent messages', recentMsgs],
    ['other tickets', others],
    ['files', files],
  ] as const) {
    if (res.error) throw new Error(`getReplyContext: ${name}: ${res.error.message}`)
  }

  const clientName = client.data?.client_name ?? null
  return {
    ticket: toConversationItem(conv.data, clientName),
    clientName,
    ticketMessages: (ticketMsgs.data ?? []).map((r) => toMessageItem(r, team)).reverse(),
    recentMessages: (recentMsgs.data ?? []).map((r) => toMessageItem(r, team)).reverse(),
    otherTickets: (others.data ?? []).map((r) => toConversationItem(r, clientName)),
    files: (files.data ?? []).map(toDocumentItem),
  }
}
