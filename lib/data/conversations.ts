import 'server-only'
import { z } from 'zod'
import { maskCredentials, maskTaxIds } from '@/lib/ai/redact'
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError } from '@/lib/auth/roles'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { Row, Update } from '@/lib/db/types'
import { chunk, fetchAll } from './paginate'
import { assertCanMutate, canAccessClient, isInvalidInput, scopedClientIds, scopeOf, type Db } from './scope'
import type { ClosedBy, ConversationItem, ConversationPatch } from './types'

export const CONV_COLS =
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
    // AI-written: credentials and tax ids (PAN, GSTIN) hidden, also in summaries saved before the tax-id mask.
    title: r.title == null ? null : maskTaxIds(maskCredentials(r.title)),
    summary: maskTaxIds(maskCredentials(r.summary)),
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

/**
 * Who closed a ticket. The council closes with closed_at = the closing message's time; a person (Shadow or a
 * Teams button) closes with closed_at = the click time. So a closed ticket whose closed_at equals the time of a
 * council "close" message was closed by the AI. undefined while open. Pure.
 */
export function decideClosedBy(closedAt: string | null, aiCloseTimes: readonly string[] | undefined): ClosedBy | undefined {
  if (!closedAt) return undefined
  const at = Date.parse(closedAt)
  return aiCloseTimes?.some((t) => Date.parse(t) === at) ? 'ai' : 'person'
}

/** Ticket id -> message times of the council "close" verdicts on it. Read-only; rows are already in scope. */
async function aiCloseTimes(db: Db, ticketIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const verdicts: { message_id: string; final_conv_id: string | null }[] = []
  for (const part of chunk([...new Set(ticketIds)])) {
    const { data, error } = await db
      .from('council_verdicts')
      .select('message_id, final_conv_id')
      .eq('final_decision', 'close')
      .in('final_conv_id', part)
    if (error) throw new Error(`aiCloseTimes: ${error.message}`)
    verdicts.push(...(data ?? []))
  }
  const times = new Map<string, string>()
  for (const part of chunk([...new Set(verdicts.map((v) => v.message_id))])) {
    const { data, error } = await db.from('client_messages').select('message_id, message_timestamp').in('message_id', part)
    if (error) throw new Error(`aiCloseTimes: ${error.message}`)
    for (const m of data ?? []) times.set(m.message_id, m.message_timestamp)
  }
  for (const v of verdicts) {
    const at = times.get(v.message_id)
    if (!v.final_conv_id || !at) continue
    out.set(v.final_conv_id, [...(out.get(v.final_conv_id) ?? []), at])
  }
  return out
}

/**
 * Ticket id -> who closed it, for closed tickets (open ones are left out). Read-only. The caller has already
 * scoped the tickets (a Shadow user's list, or the teams-notify job's pilot clients). Throws on a read error.
 */
export async function closedByMap(db: Db, tickets: { id: string; closedAt: string | null }[]): Promise<Map<string, ClosedBy>> {
  const out = new Map<string, ClosedBy>()
  const closed = tickets.filter((t) => t.closedAt)
  if (closed.length === 0) return out
  const times = await aiCloseTimes(
    db,
    closed.map((t) => t.id),
  )
  for (const t of closed) {
    const by = decideClosedBy(t.closedAt, times.get(t.id))
    if (by) out.set(t.id, by)
  }
  return out
}

/** Sets closedBy on closed tickets. A failed read only drops the label ("Closed"), never the page. */
export async function withClosedBy(db: Db, items: ConversationItem[]): Promise<ConversationItem[]> {
  if (!items.some((t) => t.closedAt)) return items
  let by: Map<string, ClosedBy>
  try {
    by = await closedByMap(db, items)
  } catch (e) {
    console.error('withClosedBy: could not read council verdicts', e)
    return items
  }
  return items.map((t) => (by.has(t.id) ? { ...t, closedBy: by.get(t.id) } : t))
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
  return withClosedBy(
    db,
    rows.map((r) => toConversationItem(r, names.get(r.client_id) ?? null)),
  )
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

/** The ticket's owner and status, or null when it does not exist or its client is outside the user's scope. Read-only. */
export async function ticketForUser(
  user: AppUser,
  id: string,
): Promise<{ id: string; clientId: string; vaId: string | null; status: string } | null> {
  if (!id) return null
  const db = createAdminSupabase()
  const { data, error } = await db.from('conversations').select('id, client_id, va_id, status').eq('id', id).maybeSingle()
  if (error) {
    if (isInvalidInput(error)) return null
    throw new Error(`ticketForUser: ${error.message}`)
  }
  if (!data) return null
  if (!(await canAccessClient(db, user, data.client_id))) return null
  return { id: data.id, clientId: data.client_id, vaId: data.va_id, status: data.status }
}

/**
 * Admin only (never while viewing as). Sets conversations.va_id for one ticket.
 * Throws ForbiddenError, Error('Accountant not found.') or Error('Ticket not found.').
 */
export async function reassignTicket(user: AppUser, id: string, vaId: string): Promise<void> {
  assertCanMutate(user, ['admin'])
  const db = createAdminSupabase()
  const va = await db.from('vas').select('va_id').eq('va_id', vaId).maybeSingle()
  if (va.error && !isInvalidInput(va.error)) throw new Error(`reassignTicket: ${va.error.message}`)
  if (!va.data) throw new Error('Accountant not found.')
  const { data, error } = await db
    .from('conversations')
    .update({ va_id: vaId, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
  if (error && !isInvalidInput(error)) throw new Error(`reassignTicket: ${error.message}`)
  if (!data || data.length === 0) throw new Error('Ticket not found.')
}
