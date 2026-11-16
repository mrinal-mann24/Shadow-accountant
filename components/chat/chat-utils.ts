// Pure helpers for the chat UI (client-safe), unit tested.
import { isToolUIPart, type UIMessage } from 'ai'
import { citationsFromToolOutput, type Citation } from '@/lib/agent/citations'

export type CitedSource = { citation: Citation; preview: string | null }

const TOOL_ACTIVITY: Record<string, string> = {
  searchMessages: 'Searching WhatsApp messages',
  getTickets: 'Reading tickets',
  getFiles: 'Looking through files',
  getMeetings: 'Reading meetings',
  getClientProfile: 'Reading the client profile',
}

/** All text parts of a message joined. */
export function messageText(m: UIMessage): string {
  return m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim()
}

function toolName(type: string): string {
  return type.startsWith('tool-') ? type.slice(5) : type
}

function previewOf(item: Record<string, unknown>): string | null {
  for (const key of ['text', 'summary', 'excerpt']) {
    const v = item[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  if (typeof item.folder === 'string') return item.folder
  return null
}

/** Every source returned by tools in this message, keyed by citation number. */
export function messageSources(m: UIMessage): Map<number, CitedSource> {
  const out = new Map<number, CitedSource>()
  for (const p of m.parts) {
    if (!isToolUIPart(p) || p.state !== 'output-available') continue
    const output = p.output as { items?: unknown[] } | undefined
    const citations = citationsFromToolOutput(output)
    const items = Array.isArray(output?.items) ? output.items : []
    for (const c of citations) {
      const item = items.find((it) => (it as { citation?: Citation })?.citation?.n === c.n) as Record<string, unknown> | undefined
      out.set(c.n, { citation: c, preview: item ? previewOf(item) : null })
    }
  }
  return out
}

/** What the assistant is doing right now, for the status line ("Searching WhatsApp messages"). */
export function currentActivity(m: UIMessage | null): string | null {
  if (!m) return null
  for (let i = m.parts.length - 1; i >= 0; i--) {
    const p = m.parts[i]
    if (p.type === 'text' && p.text.trim()) return null
    if (isToolUIPart(p) && p.state !== 'output-available' && p.state !== 'output-error') {
      return TOOL_ACTIVITY[toolName(p.type)] ?? 'Looking this up'
    }
  }
  return null
}

/** The request body turns for /api/chat: role and plain text only. */
export function toTurns(messages: UIMessage[]): { role: 'user' | 'assistant'; text: string }[] {
  return messages
    .filter((m): m is UIMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, text: messageText(m) }))
    .filter((t) => t.text.length > 0)
}

/** Error text from a failed /api/chat call: the JSON { error } when present. */
export function chatErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '')
  try {
    const parsed = JSON.parse(raw) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  } catch {
    // not JSON: a short plain message (for example the stream error text from the route) is shown as is
    if (raw && raw.length <= 200 && !raw.trimStart().startsWith('<')) return raw
  }
  return 'Could not get an answer. Please try again.'
}

/** Light clean-up of model markdown for plain text display: drops bold and heading markers. */
export function plainText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '')
}
