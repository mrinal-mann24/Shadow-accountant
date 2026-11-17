// Prompt safety for any text written by clients or staff before it goes inside a model prompt (council, Draft
// reply). Pure and client-safe.
import { maskCredentials } from './redact'

export const MAX_BODY_CHARS = 1500

/**
 * Hides credential values (never sent to a model), escapes text so it cannot close our tags or fake new ones,
 * and caps its length.
 */
export function sanitiseBody(body: string): string {
  const masked = maskCredentials(body)
  const trimmed = masked.length > MAX_BODY_CHARS ? `${masked.slice(0, MAX_BODY_CHARS)} [truncated]` : masked
  return trimmed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
