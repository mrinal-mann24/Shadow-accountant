// Shared by the AI reply drafts pilot scripts (style-guide.ts, draft-test.ts): how a client chat is masked and shown
// to a model. Pure. Credential values are masked by sanitiseBody (and by toMessageItem before that).
import { sanitiseBody } from '@/lib/ai/sanitise'
import type { MessageItem } from '@/lib/data/types'

/** Phone numbers, account numbers and other long digit runs (9+ digits, spaces or dashes allowed) become [number]. */
export function maskNumbers(text: string): string {
  return text.replace(/\+?\d[\d\s-]{7,}\d/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[number]' : m))
}

/** One message body, masked, escaped for a prompt and on one line. */
export function clean(m: MessageItem): string {
  return maskNumbers(sanitiseBody(m.body ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
}

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

/** "26 Nov 2026, 5:42 pm" in IST. */
export function istTime(iso: string): string {
  return IST.format(new Date(iso))
}

/** "[26 Nov 2026, 5:42 pm] Our team (Name): text" */
export function line(m: MessageItem): string {
  const who = m.direction === 'outgoing' ? 'Our team' : 'Client'
  const name = m.senderName ? ` (${maskNumbers(m.senderName).slice(0, 40)})` : ''
  return `[${istTime(m.at)}] ${who}${name}: ${clean(m)}`
}

/** File-safe client slug, the same for every pilot script: "Forelife Health ..." -> "forelife-health-...". */
export function slugOf(clientName: string): string {
  return clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
