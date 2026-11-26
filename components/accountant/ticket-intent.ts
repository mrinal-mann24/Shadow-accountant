// Parses the ticket action form (close / reopen / change tag). Pure and client-safe.
import { TAGS, type Tag } from '@/lib/council/types'

export type TicketActionState = { ok: boolean; message: string | null }

export type TicketIntent =
  | { ok: true; id: string; intent: 'close' | 'reopen' }
  | { ok: true; id: string; intent: 'tag'; tag: Tag }
  | { ok: false; message: string }

export const TAG_LABELS: Record<Tag, string> = {
  escalation: 'Escalation',
  complaint: 'Complaint',
  neutral: 'Request or question',
  positive: 'Praise',
  suspense: 'Suspense entry',
}

export function isTag(v: unknown): v is Tag {
  return typeof v === 'string' && (TAGS as readonly string[]).includes(v)
}

export function parseTicketIntent(form: FormData): TicketIntent {
  const id = form.get('id')
  const intent = form.get('intent')
  if (typeof id !== 'string' || !id.trim()) return { ok: false, message: 'Ticket not found.' }
  if (intent === 'close' || intent === 'reopen') return { ok: true, id: id.trim(), intent }
  if (intent === 'tag') {
    const tag = form.get('tag')
    if (!isTag(tag)) return { ok: false, message: 'Please choose a valid tag.' }
    return { ok: true, id: id.trim(), intent, tag }
  }
  return { ok: false, message: 'Unknown action.' }
}
