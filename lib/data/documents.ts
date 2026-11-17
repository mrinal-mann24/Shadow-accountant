import 'server-only'
import type { AppUser } from '@/lib/auth/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getTeamNumbers, normalizePhone } from '@/lib/team'
import type { Row } from '@/lib/db/types'
import { fetchAll } from './paginate'
import { canAccessClient } from './scope'
import type { DocumentItem, MeetingItem } from './types'

export const DOCUMENT_COLS = 'upload_id, client_id, file_name, folder_name, file_type, file_size, uploaded_at, group_name, sender_phone'
export const MEETING_COLS =
  'id, client_id, subject, meeting_start, meeting_end, meeting_date, meeting_duration_minutes, organizer_name, poc_name, meeting_type, transcript_status, teams_url, transcript'

type DocRow = Pick<
  Row<'document_uploads'>,
  'upload_id' | 'client_id' | 'file_name' | 'folder_name' | 'file_type' | 'file_size' | 'uploaded_at' | 'group_name'
>
type MeetingRow = Pick<
  Row<'va_meeting_transcripts'>,
  | 'id'
  | 'client_id'
  | 'subject'
  | 'meeting_start'
  | 'meeting_end'
  | 'meeting_date'
  | 'meeting_duration_minutes'
  | 'organizer_name'
  | 'poc_name'
  | 'meeting_type'
  | 'transcript_status'
  | 'teams_url'
  | 'transcript'
>

export function toDocumentItem(r: DocRow): DocumentItem {
  const folder = r.folder_name.replace(/\/+$/, '')
  // File names are shown as they are: masking them hid real names ("Password protected statement.pdf").
  const fileName = r.file_name
  return {
    id: r.upload_id,
    clientId: r.client_id,
    fileName,
    folderName: r.folder_name,
    path: fileName ? `${folder}/${fileName}` : folder,
    fileType: r.file_type,
    fileSize: r.file_size,
    uploadedAt: r.uploaded_at,
    groupName: r.group_name,
    url: null,
  }
}

export function toMeetingItem(r: MeetingRow): MeetingItem {
  return {
    id: r.id,
    clientId: r.client_id,
    subject: r.subject,
    start: r.meeting_start,
    end: r.meeting_end,
    date: r.meeting_date,
    durationMinutes: r.meeting_duration_minutes,
    organizerName: r.organizer_name,
    pocName: r.poc_name,
    meetingType: r.meeting_type,
    transcriptStatus: r.transcript_status,
    hasTranscript: !!r.transcript && r.transcript.trim().length > 0,
    link: r.teams_url,
  }
}

/** Files logged in document_uploads (WhatsApp files saved to SharePoint), newest first. [] when out of scope. */
/** True when a file was sent by the client (not by a team number). Unknown sender counts as the client's. */
export function isClientFile(r: { sender_phone: string | null }, team: Set<string>): boolean {
  const phone = normalizePhone(r.sender_phone)
  return phone === null || !team.has(phone)
}

/** clientOnly: leave out files our team sent into the group (the client page shows only what the client sent). */
export async function listDocuments(user: AppUser, clientId: string, o: { clientOnly?: boolean } = {}): Promise<DocumentItem[]> {
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, clientId))) return []
  const rows = await fetchAll('listDocuments', (from, to) =>
    db
      .from('document_uploads')
      .select(DOCUMENT_COLS)
      .eq('client_id', clientId)
      .order('uploaded_at', { ascending: false, nullsFirst: false })
      .order('upload_id')
      .range(from, to),
  )
  if (!o.clientOnly) return rows.map(toDocumentItem)
  const team = await getTeamNumbers()
  return rows.filter((r) => isClientFile(r, team)).map(toDocumentItem)
}

/** Meetings linked to the client (va_meeting_transcripts.client_id), newest first. [] when out of scope. */
export async function listMeetings(user: AppUser, clientId: string): Promise<MeetingItem[]> {
  const db = createAdminSupabase()
  if (!(await canAccessClient(db, user, clientId))) return []
  const rows = await fetchAll('listMeetings', (from, to) =>
    db
      .from('va_meeting_transcripts')
      .select(MEETING_COLS)
      .eq('client_id', clientId)
      .order('meeting_start', { ascending: false, nullsFirst: false })
      .order('id')
      .range(from, to),
  )
  return rows.map(toMeetingItem)
}
