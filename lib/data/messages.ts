import 'server-only'
import type { AppUser } from '@/lib/auth/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { Row } from '@/lib/db/types'
import { effectiveDirection, getTeamNumbers, normalizePhone } from '@/lib/team'
import { canAccessClient } from './scope'
import type { MessageItem } from './types'

export const MESSAGE_COLS =
  'message_id, dedup_hash, message_timestamp, body, sender_name, sender_phone, direction, message_type, conversation_id, client_id'

type MessageRow = Pick<
  Row<'client_messages'>,
  | 'message_id'
  | 'dedup_hash'
  | 'message_timestamp'
  | 'body'
  | 'sender_name'
  | 'sender_phone'
  | 'direction'
  | 'message_type'
  | 'conversation_id'
>

export function toMessageItem(r: MessageRow, team: Set<string>): MessageItem {
  const phone = normalizePhone(r.sender_phone)
  return {
    id: r.message_id,
    waMessageId: r.dedup_hash,
    at: r.message_timestamp,
    body: r.body ?? '',
    senderName: r.sender_name,
    direction: effectiveDirection(r, team),
    storedDirection: r.direction,
    fromTeam: phone !== null && team.has(phone),
    messageType: r.message_type,
    conversationId: r.conversation_id,
  }
}

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return fallback
  return Math.min(Math.floor(limit), max)
}

/**
 * The newest `limit` messages (default 50, max 200) before `before` (ISO time), returned oldest first.
 * For the next older page pass the first item's `at` as `before`. [] when out of scope.
 */
export async function listMessages(
  user: AppUser,
  clientId: string,
  o: { before?: string; limit?: number } = {},
): Promise<MessageItem[]> {
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, clientId))) return []
  const limit = clampLimit(o.limit, 50, 200)
  let q = db.from('client_messages').select(MESSAGE_COLS).eq('client_id', clientId)
  if (o.before) {
    const before = new Date(o.before)
    if (Number.isNaN(before.getTime())) return []
    q = q.lt('message_timestamp', before.toISOString())
  }
  const [team, res] = await Promise.all([
    getTeamNumbers(),
    q.order('message_timestamp', { ascending: false }).order('message_id', { ascending: false }).limit(limit),
  ])
  if (res.error) throw new Error(`listMessages: ${res.error.message}`)
  return (res.data ?? []).map((r) => toMessageItem(r, team)).reverse()
}
