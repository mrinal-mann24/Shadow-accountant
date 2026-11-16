import 'server-only'
import { z } from 'zod'
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError } from '@/lib/auth/roles'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { Row, Update } from '@/lib/db/types'
import { chunk, fetchAll } from './paginate'
import { assertCanMutate, canAccessClient, isInvalidInput, scopedClientIds, scopeOf, type Db } from './scope'
import type { ConversationItem, ConversationPatch } from './types'

const CONV_COLS =
  'id, client_id, va_id, title, summary, status, tag, fault, client_tone, va_tone, sla_breached, opened_at, opened_by, closed_at, last_message_at, last_message_direction, message_count'

type ConvRow = Pick<
  Row<'conversations'>,
  | 'id'
  | 'client_id'
  | 'va_id'
  | 'title'
  | 'summary'
  | 'status'
  | 'tag'
  | 'fault'
  | 'client_tone'
  | 'va_tone'
  | 'sla_breached'
  | 'opened_at'
  | 'opened_by'
  | 'closed_at'
  | 'last_message_at'
  | 'last_message_direction'
  | 'message_count'
>

export function toConversationItem(r: ConvRow, clientName: string | null): ConversationItem {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName,
    vaId: r.va_id,
    title: r.title,
    summary: r.summary,
    status: r.status,
    tag: r.tag,
    fault: r.fault,
    clientTone: r.client_tone,
    vaTone: r.va_tone,
    slaBreached: r.sla_breached,
    openedAt: r.opened_at,
    openedBy: r.opened_by,
    closedAt: r.closed_at,
    lastMessageAt: r.last_message_at,
    lastMessageDirection: r.last_message_direction,
    messageCount: r.message_count,
  }
}

async function clientNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const part of chunk([...new Set(ids)])) {
    const { data, error } = await db.from('clients').select('client_id, client_name').in('client_id', part)
    if (error) throw new Error(`clientNames: ${error.message}`)
    for (const c of data ?? []) out.set(c.client_id, c.client_name)
  }
  return out
}

/** Tickets in scope, most recent activity first. [] when the client is out of scope. */
export async function listConversations(
  user: AppUser,
  f: { clientId?: string; status?: 'open' | 'closed'; tag?: string } = {},
): Promise<ConversationItem[]> {
  const db = createAdminSupabase()
  let ids: string[] | null
  if (f.clientId) {
    if (!(await canAccessClient(db, user, f.clientId))) return []
    ids = [f.clientId]
  } else {
    ids = await scopedClientIds(db, user)
    if (ids && ids.length === 0) return []
  }

  const page = (part: string[] | null) =>
    fetchAll('listConversations', (from, to) => {
      let q = db.from('conversations').select(CONV_COLS)
      if (part) q = q.in('client_id', part)
      if (f.status) q = q.eq('status', f.status)
      if (f.tag) q = q.eq('tag', f.tag)
      return q.order('last_message_at', { ascending: false }).order('id').range(from, to)
    })

  const rows: ConvRow[] = []
  if (ids === null) rows.push(...(await page(null)))
  else for (const part of chunk(ids)) rows.push(...(await page(part)))
  rows.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))

  const names = await clientNames(
    db,
    rows.map((r) => r.client_id),
  )
  return rows.map((r) => toConversationItem(r, names.get(r.client_id) ?? null))
}

export const conversationPatchSchema = z
  .object({
    status: z.enum(['open', 'closed']).optional(),
    tag: z.string().trim().min(1).max(40).optional(),
    summary: z.string().trim().max(5000).optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict()

/** Builds the DB update for a validated patch. Closing sets closed_at, reopening clears it. */
export function buildConversationUpdate(patch: ConversationPatch, now: Date): Update<'conversations'> | null {
  const p = conversationPatchSchema.parse(patch)
  const out: Update<'conversations'> = {}
  if (p.status !== undefined) {
    out.status = p.status
    out.closed_at = p.status === 'closed' ? now.toISOString() : null
  }
  if (p.tag !== undefined) out.tag = p.tag
  if (p.summary !== undefined) out.summary = p.summary
  if (p.title !== undefined) out.title = p.title
  if (Object.keys(out).length === 0) return null
  out.updated_at = now.toISOString()
  return out
}

/**
 * Senior accountant (own clients) or admin. Never while viewing as. Throws ForbiddenError when the
 * ticket is outside the user's scope, Error('Ticket not found.') when it does not exist.
 */
export async function updateConversation(user: AppUser, id: string, patch: ConversationPatch): Promise<void> {
  assertCanMutate(user, ['senior_accountant', 'admin'])
  const update = buildConversationUpdate(patch, new Date())
  const db = createAdminSupabase()
  const { data: conv, error } = await db.from('conversations').select('id, client_id').eq('id', id).maybeSingle()
  if (error && !isInvalidInput(error)) throw new Error(`updateConversation: ${error.message}`)
  if (!conv) throw new Error('Ticket not found.')
  const scope = scopeOf(user)
  if (!scope.all && !(await canAccessClient(db, user, conv.client_id))) {
    throw new ForbiddenError()
  }
  if (!update) return
  const res = await db.from('conversations').update(update).eq('id', id)
  if (res.error) throw new Error(`updateConversation: ${res.error.message}`)
}
