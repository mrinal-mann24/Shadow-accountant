'use server'
// "Suggested reply" for one ticket (AI reply drafts). Writing a suggestion works for every signed-in role that can see
// the ticket (viewing as someone gets the reply but nothing is saved). Recording what was done with it (copied,
// edited, discarded) is how the AI learns; not while viewing as someone. Both are scoped by lib/data.
import { requireUser } from '@/lib/auth/session'
import { ForbiddenError, ViewAsReadOnlyError } from '@/lib/auth/roles'
import { recordReplySuggestion, SUGGESTION_ACTIONS, type SuggestionAction } from '@/lib/data/reply-suggestions'
import { suggestReply, type SuggestResult } from '@/lib/reply/suggest'

/** force: Regenerate (write a new suggestion even when one exists for the client's latest message). */
export async function suggestReplyAction(ticketId: string, force = false): Promise<SuggestResult> {
  const user = await requireUser()
  const id = typeof ticketId === 'string' ? ticketId.trim() : ''
  if (!id || id.length > 100) return { ok: false, reason: 'not_found', message: 'Ticket not found.' }
  return suggestReply(user, id, { force: force === true })
}

export type RecordSuggestionResult = { ok: boolean; message: string | null }

export async function recordSuggestionAction(
  suggestionId: string,
  action: SuggestionAction,
  finalText: string | null,
): Promise<RecordSuggestionResult> {
  const user = await requireUser()
  const id = typeof suggestionId === 'string' ? suggestionId.trim() : ''
  if (!id || id.length > 100) return { ok: false, message: 'Suggestion not found.' }
  if (!(SUGGESTION_ACTIONS as readonly string[]).includes(action)) return { ok: false, message: 'Unknown action.' }
  if (finalText !== null && typeof finalText !== 'string') return { ok: false, message: 'Unknown text.' }
  try {
    await recordReplySuggestion(user, id, action, finalText)
    return { ok: true, message: null }
  } catch (e) {
    if (e instanceof ViewAsReadOnlyError) return { ok: false, message: 'Read only while viewing as someone.' }
    if (e instanceof ForbiddenError) return { ok: false, message: 'You do not have access to this ticket.' }
    if (e instanceof Error && e.message === 'Suggestion not found.') return { ok: false, message: e.message }
    console.error('recordSuggestionAction failed', e instanceof Error ? e.message : e)
    return { ok: false, message: 'Could not save that. The reply is still copied.' }
  }
}
