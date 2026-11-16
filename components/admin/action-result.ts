// Result shape for the Admin / Engineer server actions, and how errors are shown to the user. Client-safe.
import { ForbiddenError } from '@/lib/auth/roles'

export type ActionResult = { ok: true } | { ok: false; error: string }

export const GENERIC_ERROR = 'Something went wrong. Please try again.'

/** Messages from lib/data that are safe and useful to show as they are. */
const SAFE_MESSAGES = new Set([
  'Client not found.',
  'Accountant not found.',
  'Processing record not found.',
])

/**
 * ForbiddenError (and ViewAsReadOnlyError) messages are written for users, so they are shown.
 * Known "not found" messages are shown. Anything else (database text) is logged and replaced.
 */
export function toActionError(e: unknown): ActionResult {
  if (e instanceof ForbiddenError) return { ok: false, error: e.message }
  if (e instanceof Error && SAFE_MESSAGES.has(e.message)) return { ok: false, error: e.message }
  console.error('[admin-engineer-ui] action failed', e)
  return { ok: false, error: GENERIC_ERROR }
}
