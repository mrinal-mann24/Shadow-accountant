import 'server-only'
import type { AppUser } from '@/lib/auth/types'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { Row } from '@/lib/db/types'
import { fetchAll } from './paginate'
import { canAccessClient } from './scope'
import type { DocumentItem, MeetingItem } from './types'

export const DOCUMENT_COLS = 'upload_id, client_id, file_name, folder_name, file_type, file_size, uploaded_at, group_name'
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
  return {
    id: r.upload_id,
    clientId: r.client_id,
    fileName: r.file_name,
    folderName: r.folder_name,
    path: r.file_name ? `${folder}/${r.file_name}` : folder,
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
export async function listDocuments(user: AppUser, clientId: string): Promise<DocumentItem[]> {
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
  return rows.map(toDocumentItem)
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
