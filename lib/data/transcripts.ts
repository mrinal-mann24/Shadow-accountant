import 'server-only'
import { randomUUID } from 'node:crypto'
import type { AppUser } from '@/lib/auth/types'
import { ForbiddenError } from '@/lib/auth/roles'
import { maskCredentials } from '@/lib/ai/redact'
import { istDate } from '@/lib/followups/dates'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { assertCanMutate, canAccessClient } from './scope'

// Saves a transcript or meeting notes that a team member shared with Shadow in Teams (after they pressed Save) as a
// meeting of the client in va_meeting_transcripts. It then shows on the client page, in the timeline and in the AI
// chat (getMeetings). Rows get their own ical_uid prefix, so they never clash with the n8n meeting flows.

export const TEAMS_SOURCE = 'shadow-teams'
export const MAX_TRANSCRIPT_CHARS = 40_000
const MAX_SUBJECT = 200

export type SaveTranscriptInput = {
  clientId: string
  title: string
  /** YYYY-MM-DD (IST) or null: the day it was saved. */
  meetingDate: string | null
  transcript: string
  now?: Date
}

/**
 * Throws ViewAsReadOnlyError while viewing as someone, ForbiddenError when the client is outside the user's scope (or
 * the role may not change data), and Error for an empty text or a database error. Credentials are masked before
 * storing (CLAUDE.md: never store client passwords).
 */
export async function saveClientTranscript(user: AppUser, input: SaveTranscriptInput): Promise<{ id: string }> {
  assertCanMutate(user, ['senior_accountant', 'admin', 'engineer'])
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, input.clientId))) throw new ForbiddenError()

  const transcript = maskCredentials(input.transcript).trim().slice(0, MAX_TRANSCRIPT_CHARS)
  if (!transcript) throw new Error('Nothing to save.')
  const now = input.now ?? new Date()
  const date = input.meetingDate ?? istDate(now.toISOString())
  const start = input.meetingDate ? new Date(`${input.meetingDate}T12:00:00+05:30`).toISOString() : now.toISOString()
  const subject = maskCredentials(input.title).replace(/\s+/g, ' ').trim().slice(0, MAX_SUBJECT) || 'Notes saved from Teams'

  const { data, error } = await db
    .from('va_meeting_transcripts')
    .insert({
      ical_uid: `${TEAMS_SOURCE}:${randomUUID()}`,
      client_id: input.clientId,
      subject,
      meeting_type: 'Virtual Accounting',
      meeting_date: date,
      meeting_start: start,
      organizer_name: user.name,
      organizer_email: user.email,
      transcript,
      contact_source: TEAMS_SOURCE,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`saveClientTranscript: ${error?.message ?? 'no row'}`)
  return { id: data.id }
}
