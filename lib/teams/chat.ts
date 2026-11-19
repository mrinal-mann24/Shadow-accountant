// Shadow 1:1 chat in Teams: memory of the last turns and "save this transcript to a client" requests.
// Pure helpers and types only (no I/O), so they are unit tested. Storage: lib/teams/chat-store.ts (table teams_chat,
// supabase/applied/2026-11-19-teams-chat.sql).
//
// Flow: a 1:1 message is answered with the person's last MEMORY_TURNS turns of the last MEMORY_WINDOW_MS as context.
// When the user asks to store a transcript or meeting notes, the model can only *propose* it (tool proposeSave in
// lib/agent/ask.ts). The bot keeps the text as a pending_save row and posts a card; nothing is written to the client
// until the user presses Save, and then lib/data saveClientTranscript checks the user's access again.

import type { ChatTurn } from '@/lib/agent/scope'

export const MEMORY_TURNS = 10
export const MEMORY_WINDOW_MS = 2 * 60 * 60_000
/** Each earlier turn is cut to this many characters when it is sent to the model again. */
export const HISTORY_TURN_CHARS = 2000
/** Longest message kept (a Teams message is at most about 28 KB). The table allows 40,000. */
export const MAX_MESSAGE_CHARS = 30_000
/** Shortest text worth saving. */
export const MIN_SAVE_CHARS = 20
/** A Save card works for this long. */
export const PENDING_TTL_MS = 24 * 60 * 60_000
/** Rows older than this are deleted by the teams-notify job. */
export const CHAT_RETENTION_MS = 7 * 24 * 60 * 60_000

export const NEW_CHAT = /^(new chat|reset|start over|forget)$/i

export type ChatRow = { kind: 'user' | 'assistant'; content: string; created_at: string }

/** What the model asked to save (lib/agent/ask.ts proposeSave). */
export type SaveProposal = {
  clientId: string
  clientName: string
  title: string
  /** YYYY-MM-DD (IST) or null when not said. */
  meetingDate: string | null
  /** Where the text is: this message, or the user's previous message in this chat. */
  source: 'this_message' | 'previous_message'
  /** The first words of the transcript inside the message, so a request line before it is not saved. */
  startsWith: string | null
}

export type PendingMeta = { clientId: string; clientName: string; title: string; meetingDate: string | null }
export type PendingSave = { id: string; email: string; content: string; meta: PendingMeta; createdAt: string }

export interface TeamsChatStore {
  /** The person's user and assistant turns created after `since`, oldest first, at most `limit` (the newest ones). */
  recentTurns(email: string, since: string, limit: number): Promise<ChatRow[]>
  addTurns(email: string, turns: { kind: 'user' | 'assistant'; content: string }[]): Promise<void>
  /** Forgets the person's turns (pending saves stay). */
  clear(email: string): Promise<void>
  addPending(email: string, content: string, meta: PendingMeta): Promise<string>
  /** The pending save when it belongs to this person, else null. */
  getPending(id: string, email: string): Promise<PendingSave | null>
  /** Deletes and returns the pending save (only for this person). null when it is already gone: the caller stops. */
  takePending(id: string, email: string): Promise<PendingSave | null>
  /** Deletes rows created before `before`. Returns how many. */
  prune(before: string): Promise<number>
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" }

/**
 * Message text for saving and for the model, keeping line breaks: <br>, </p>, </div> and </li> become new lines,
 * mentions and other tags are removed, common entities decoded, spaces collapsed inside lines, and 3+ blank lines
 * collapsed to one. Cut to MAX_MESSAGE_CHARS.
 */
export function cleanLongText(text: string | undefined): string {
  return (text ?? '')
    .replace(/<at[^>]*>[\s\S]*?<\/at>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    // One line break between blocks ("</p><p>"), and one at any other block start or end.
    .replace(/<\/(p|div|li|tr|h[1-6])>\s*<(p|div|li|tr|h[1-6])(\s[^>]*)?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|h[1-6])(\s[^>]*)?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS)
}

/** Earlier turns for the model: cut, and old citation markers [n] removed (they belong to earlier answers). */
export function historyTurns(rows: ChatRow[]): ChatTurn[] {
  return rows
    .map((r): ChatTurn => {
      const text = r.kind === 'assistant' ? r.content.replace(/\[\d+\]/g, '') : r.content
      const cut = text.length > HISTORY_TURN_CHARS ? `${text.slice(0, HISTORY_TURN_CHARS)}... (cut)` : text
      return { role: r.kind, text: cut.trim() }
    })
    .filter((t) => t.text.length > 0)
}

/**
 * The text to save for a proposal: this message or the previous user turn, starting at `startsWith` when it is found
 * in the first part of the text (case and spaces ignored). null when there is nothing worth saving.
 */
export function textToSave(p: SaveProposal, thisMessage: string, history: ChatRow[]): string | null {
  const source = p.source === 'previous_message' ? ([...history].reverse().find((r) => r.kind === 'user')?.content ?? '') : thisMessage
  let text = source.trim()
  const marker = (p.startsWith ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (marker.length >= 3) {
    const at = text.slice(0, 3000).replace(/\s/g, ' ').toLowerCase().indexOf(marker)
    if (at > 0) text = text.slice(at).trim()
  }
  return text.length >= MIN_SAVE_CHARS ? text : null
}

/** True when the pending save is older than PENDING_TTL_MS. */
export function pendingExpired(p: PendingSave, now: Date): boolean {
  const t = Date.parse(p.createdAt)
  return Number.isNaN(t) || now.getTime() - t > PENDING_TTL_MS
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A YYYY-MM-DD that is a real date and not after `today` (YYYY-MM-DD), else null. */
export function validMeetingDate(value: string | null | undefined, today: string): string | null {
  const v = (value ?? '').trim()
  if (!DATE.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null
  return v <= today ? v : null
}
