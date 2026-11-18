import 'server-only'
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError } from '@/lib/auth/roles'
import { addBusinessDays, istDate, istEndOfDay } from '@/lib/followups/dates'
import { FOLLOW_UP_COLS, toFollowUpRow, viewsForRows } from '@/lib/followups/store'
import type { FollowUpAction, FollowUpRow, FollowUpView } from '@/lib/followups/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { Database } from '@/lib/db/types'
import { chunk, fetchAll } from './paginate'
import { assertCanMutate, canAccessClient, isInvalidInput, scopedClientIds, scopeOf } from './scope'

// Follow-ups for screens and buttons (client page, home, Teams card actions). Scoped by the signed-in user
// like conversations.ts: senior accountants see their own clients, admins and engineers see all.

type DbRow = Database['public']['Tables']['follow_ups']['Row']
const UNRESOLVED = ['open', 'missed']
const CLOSED = ['done', 'cancelled']
/**
 * An item created more than this long after its source message was found while scanning old messages (the
 * pilot's 30-day backfill). Same rule as HISTORY_MS in lib/followups/job.ts, which never alerts for these.
 */
const HISTORY_MS = 24 * 60 * 60_000

/** True for an item found while scanning old messages (created more than 24 h after its source message). */
export function isHistoryItem(v: Pick<FollowUpView, 'createdAt' | 'sourceAt'>): boolean {
  const created = Date.parse(v.createdAt)
  const source = Date.parse(v.sourceAt)
  if (Number.isNaN(created) || Number.isNaN(source)) return false
  return created - source > HISTORY_MS
}

/** One client's follow-ups, newest first. status 'open' (default) means open or missed. [] when out of scope. */
export async function listFollowUps(
  user: AppUser,
  clientId: string,
  o: { status?: 'open' | 'all'; limit?: number } = {},
): Promise<FollowUpView[]> {
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, clientId))) return []
  const limit = Math.max(1, Math.min(o.limit ?? 50, 500))
  let q = db.from('follow_ups').select(FOLLOW_UP_COLS).eq('client_id', clientId)
  if ((o.status ?? 'open') === 'open') q = q.in('status', UNRESOLVED)
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listFollowUps: ${error.message}`)
  return viewsForRows(db, ((data ?? []) as DbRow[]).map(toFollowUpRow))
}

/** End of the IST calendar day of `now` (23:59:59.999 IST), as ISO. */
function endOfIstDay(now: Date): string {
  return new Date(`${istDate(now.toISOString())}T23:59:59.999+05:30`).toISOString()
}

/**
 * Open or missed follow-ups across the user's clients that need attention: due by the end of today (IST) or a
 * repeat ask. Most overdue first (due time, or created time when there is none). Default limit 20.
 * Items found while scanning old messages (isHistoryItem) are left out; the client page still shows them.
 */
export async function listDueFollowUps(user: AppUser, o: { limit?: number; now?: Date } = {}): Promise<FollowUpView[]> {
  const db = createAdminSupabase()
  const ids = await scopedClientIds(db, user)
  if (ids && ids.length === 0) return []
  const limit = Math.max(1, Math.min(o.limit ?? 20, 200))
  const until = endOfIstDay(o.now ?? new Date())

  const read = async (part: string[] | null): Promise<DbRow[]> => {
    const due = await fetchAll('listDueFollowUps', (from, to) => {
      let q = db.from('follow_ups').select(FOLLOW_UP_COLS).in('status', UNRESOLVED).lte('due_at', until)
      if (part) q = q.in('client_id', part)
      return q.order('due_at', { ascending: true }).order('id').range(from, to)
    })
    const repeats = await fetchAll('listDueFollowUps', (from, to) => {
      let q = db.from('follow_ups').select(FOLLOW_UP_COLS).in('status', UNRESOLVED).eq('kind', 'repeat_ask')
      if (part) q = q.in('client_id', part)
      return q.order('created_at', { ascending: true }).order('id').range(from, to)
    })
    return [...(due as DbRow[]), ...(repeats as DbRow[])]
  }

  const all: DbRow[] = []
  if (ids === null) all.push(...(await read(null)))
  else for (const part of chunk(ids)) all.push(...(await read(part)))

  const byId = new Map<string, FollowUpRow>()
  for (const r of all) if (!byId.has(r.id)) byId.set(r.id, toFollowUpRow(r))
  const key = (r: FollowUpRow) => r.due_at ?? r.created_at
  const rows = [...byId.values()].sort((a, b) => Date.parse(key(a)) - Date.parse(key(b)) || a.id.localeCompare(b.id))
  // History needs the source message time, so filter the views and only then apply the limit.
  const out: FollowUpView[] = []
  for (const part of chunk(rows)) {
    for (const v of await viewsForRows(db, part)) {
      if (isHistoryItem(v)) continue
      out.push(v)
      if (out.length >= limit) return out
    }
  }
  return out
}

/**
 * Done, cancel or extend one follow-up. Senior accountant (own clients) or admin, never while viewing as.
 * Throws ForbiddenError when the follow-up's client is outside the user's scope, Error('Follow-up not found.'),
 * Error('This follow-up is already closed.') or, for extend on a repeat ask,
 * Error('Only promises and document requests can be extended.'). Extend moves the deadline to 19:00 IST one
 * business day after the later of now and the current deadline, and reopens a missed item. It also clears the
 * alert state (escalated_at, reminder_count and, for documents, last_reminded_at), so the new deadline gets its own
 * "due today" reminder and escalation, and a document starts a fresh chase cycle.
 */
export async function followUpAction(
  user: AppUser,
  id: string,
  action: FollowUpAction,
  now = new Date(),
): Promise<FollowUpView> {
  assertCanMutate(user, ['senior_accountant', 'admin'])
  const db = createAdminSupabase()
  const { data, error } = id
    ? await db.from('follow_ups').select(FOLLOW_UP_COLS).eq('id', id).maybeSingle()
    : { data: null, error: null }
  if (error && !isInvalidInput(error)) throw new Error(`followUpAction: ${error.message}`)
  if (!data) throw new Error('Follow-up not found.')
  const row = toFollowUpRow(data as DbRow)
  if (!scopeOf(user).all && !(await canAccessClient(db, user, row.client_id))) throw new ForbiddenError()
  if (CLOSED.includes(row.status)) throw new Error('This follow-up is already closed.')

  const at = now.toISOString()
  let patch: Database['public']['Tables']['follow_ups']['Update']
  if (action === 'done' || action === 'cancel') {
    patch = { status: action === 'done' ? 'done' : 'cancelled', resolved_by: user.email, resolved_at: at }
  } else if (action === 'extend') {
    if (row.kind !== 'promise' && row.kind !== 'document') {
      throw new Error('Only promises and document requests can be extended.')
    }
    const dueMs = row.due_at ? Date.parse(row.due_at) : NaN
    const from = Number.isNaN(dueMs) || dueMs < now.getTime() ? at : new Date(dueMs).toISOString()
    patch = {
      due_at: istEndOfDay(addBusinessDays(from, 1)),
      status: 'open',
      escalated_at: null,
      reminder_count: 0,
      ...(row.kind === 'document' ? { last_reminded_at: null } : {}),
    }
  } else {
    throw new Error('Unknown follow-up action.')
  }

  // The status guard makes a close by the job in the meantime win: nothing is updated and the user is told.
  const res = await db.from('follow_ups').update(patch).eq('id', id).in('status', UNRESOLVED).select(FOLLOW_UP_COLS)
  if (res.error) throw new Error(`followUpAction: ${res.error.message}`)
  const updated = ((res.data ?? []) as DbRow[])[0]
  if (!updated) throw new Error('This follow-up is already closed.')
  const [view] = await viewsForRows(db, [toFollowUpRow(updated)])
  return view
}
