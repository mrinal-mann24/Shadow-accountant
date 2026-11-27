import 'server-only'
// AI reply drafts (Suggested reply): the pilot client's style guide (settings) and the suggestions shown with what the
// accountant did with them (reply_suggestions, supabase/proposals/reply-suggestions.sql). Scoped like every read: the
// client must be in the user's scope. Until the table and the settings rows exist, reads return nothing and writes
// save nothing, so the feature stays hidden instead of failing.
import { maskCredentials, maskTaxIds } from '@/lib/ai/redact'
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError } from '@/lib/auth/roles'
import { maskNumbers, type Correction } from '@/lib/reply/chat-text'
import { guideSettingKey, parsePilotClients, parseStoredGuide, PILOT_SETTING_KEY, type StoredGuide } from '@/lib/reply/style-guide'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { assertCanMutate, canAccessClient, isInvalidInput, type Db } from './scope'

export const SUGGESTION_ACTIONS = ['copied', 'edited', 'discarded'] as const
export type SuggestionAction = (typeof SUGGESTION_ACTIONS)[number]

/** Longest reply text stored (a WhatsApp reply; anything longer is cut). */
export const MAX_SUGGESTION_CHARS = 2000

/** The table is not there yet (the proposal SQL has not been run): Postgres 42P01 or PostgREST PGRST205. */
export function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === '42P01' || error.code === 'PGRST205' || /does not exist|could not find the table/i.test(error.message ?? '')
}

/** Masked and cut, as every reply text is before it is stored. */
export function storableText(text: string): string {
  return maskTaxIds(maskCredentials(maskNumbers(text.trim()))).slice(0, MAX_SUGGESTION_CHARS)
}

/** The style guide when the client is a pilot client with a guide; null otherwise. Read only. */
export async function readPilotGuide(db: Db, clientId: string): Promise<StoredGuide | null> {
  const { data, error } = await db.from('settings').select('key, value').in('key', [PILOT_SETTING_KEY, guideSettingKey(clientId)])
  if (error) throw new Error(`readPilotGuide: ${error.message}`)
  const byKey = new Map((data ?? []).map((r) => [r.key, r.value]))
  if (!parsePilotClients(byKey.get(PILOT_SETTING_KEY)).includes(clientId)) return null
  return parseStoredGuide(byKey.get(guideSettingKey(clientId)))
}

/** The client's style guide for this user, or null when the client is out of scope, not a pilot client or has no guide. */
export async function getReplyStyle(user: AppUser, clientId: string): Promise<StoredGuide | null> {
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, clientId))) return null
  return readPilotGuide(db, clientId)
}

/** Latest corrections (edited suggestions) for a client, newest first. [] when none or before the table exists. */
export async function readCorrections(db: Db, clientId: string, limit: number): Promise<Correction[]> {
  const { data, error } = await db
    .from('reply_suggestions')
    .select('draft, final_text')
    .eq('client_id', clientId)
    .eq('action', 'edited')
    .order('acted_at', { ascending: false })
    .limit(limit)
  if (error) {
    if (isMissingTable(error)) return []
    throw new Error(`readCorrections: ${error.message}`)
  }
  return (data ?? []).filter((r) => r.final_text).map((r) => ({ draft: r.draft, finalText: r.final_text! }))
}

/** readCorrections for a client in the user's scope ([] otherwise). */
export async function listReplyCorrections(user: AppUser, clientId: string, limit: number): Promise<Correction[]> {
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, clientId))) return []
  return readCorrections(db, clientId, limit)
}

export type SavedSuggestion = {
  id: string
  draft: string
  finalText: string | null
  action: SuggestionAction | null
  guideVersion: number | null
}

/**
 * The latest suggestion for this ticket written at or after `since` (the client's last message) and not discarded,
 * so opening the ticket again shows it instead of paying for a new one. null when there is none, the client is out
 * of scope, or before the table exists.
 */
export async function findRecentSuggestion(
  user: AppUser,
  o: { conversationId: string; clientId: string; since: string },
): Promise<SavedSuggestion | null> {
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, o.clientId))) return null
  const { data: rows, error } = await db
    .from('reply_suggestions')
    .select('id, draft, final_text, action, guide_version')
    .eq('conversation_id', o.conversationId)
    .eq('client_id', o.clientId)
    .gte('created_at', o.since)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) {
    if (isMissingTable(error)) return null
    throw new Error(`findRecentSuggestion: ${error.message}`)
  }
  const data = (rows ?? []).find((r) => r.action !== 'discarded')
  if (!data) return null
  const action = (SUGGESTION_ACTIONS as readonly string[]).includes(data.action ?? '') ? (data.action as SuggestionAction) : null
  return { id: data.id, draft: data.draft, finalText: data.final_text, action, guideVersion: data.guide_version }
}

/**
 * Saves a suggestion that was shown. Returns its id, or null when nothing was saved: viewing as someone (read only)
 * or the table does not exist yet. Throws ForbiddenError when the client is out of scope.
 */
export async function saveReplySuggestion(
  user: AppUser,
  row: { conversationId: string; clientId: string; model: string; guideVersion: number | null; promptVersion: string; draft: string },
): Promise<string | null> {
  if (user.viewingAs) return null
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, row.clientId))) throw new ForbiddenError()
  const { data, error } = await db
    .from('reply_suggestions')
    .insert({
      conversation_id: row.conversationId,
      client_id: row.clientId,
      user_email: user.email,
      model: row.model,
      guide_version: row.guideVersion,
      prompt_version: row.promptVersion,
      draft: storableText(row.draft),
    })
    .select('id')
    .maybeSingle()
  if (error) {
    if (isMissingTable(error)) return null
    throw new Error(`saveReplySuggestion: ${error.message}`)
  }
  return data?.id ?? null
}

/**
 * Records what the accountant did with a suggestion: copied it as is, edited then copied it (finalText is what they
 * copied), or discarded it. A later action replaces an earlier one (copy, then edit and copy again). Not while viewing
 * as someone. Throws ForbiddenError when the suggestion's client is out of scope, Error('Suggestion not found.') when
 * it does not exist. Does nothing before the table exists.
 */
export async function recordReplySuggestion(user: AppUser, id: string, action: SuggestionAction, finalText: string | null): Promise<void> {
  assertCanMutate(user, ['senior_accountant', 'admin', 'engineer'])
  if (!(SUGGESTION_ACTIONS as readonly string[]).includes(action)) throw new Error('Unknown action.')
  const db = createAdminSupabase()
  const { data, error } = await db.from('reply_suggestions').select('id, client_id, draft').eq('id', id).maybeSingle()
  if (error) {
    if (isMissingTable(error)) return
    if (isInvalidInput(error)) throw new Error('Suggestion not found.')
    throw new Error(`recordReplySuggestion: ${error.message}`)
  }
  if (!data) throw new Error('Suggestion not found.')
  if (!(await canAccessClient(db, user, data.client_id))) throw new ForbiddenError()
  const final = action === 'discarded' || finalText == null ? null : storableText(finalText)
  // "Edited" only when the text really changed; an untouched copy is "copied".
  const effective: SuggestionAction = action === 'edited' && final !== null && final === data.draft ? 'copied' : action
  const res = await db
    .from('reply_suggestions')
    .update({ action: effective, final_text: final, acted_at: new Date().toISOString() })
    .eq('id', id)
  if (res.error && !isMissingTable(res.error)) throw new Error(`recordReplySuggestion: ${res.error.message}`)
}
