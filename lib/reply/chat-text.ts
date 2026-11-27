// How a client chat is masked and shown to a model, for the AI reply drafts (Suggested reply, the style guide job and
// the pilot scripts). Pure and client-safe. Credential values are masked by sanitiseBody (and by toMessageItem before
// that); phone, account and other long numbers become [number].
import { sanitiseBody } from '@/lib/ai/sanitise'
import type { MessageItem } from '@/lib/data/types'

/** Phone numbers, account numbers and other long digit runs (9+ digits, spaces or dashes allowed) become [number]. */
export function maskNumbers(text: string): string {
  return text.replace(/\+?\d[\d\s-]{7,}\d/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[number]' : m))
}

/** One message body, masked, escaped for a prompt and on one line. */
export function clean(m: Pick<MessageItem, 'body'>): string {
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
export function line(m: Pick<MessageItem, 'at' | 'body' | 'direction' | 'senderName'>): string {
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

/** A correction an accountant made to an AI draft (both masked), newest first. */
export type Correction = { draft: string; finalText: string }

/** Prompt block listing accountants' corrections to earlier AI drafts. '' when there are none. */
export function correctionsBlock(corrections: Correction[], heading: string): string {
  if (!corrections.length) return ''
  const items = corrections.map(
    (c, i) =>
      `${i + 1}. AI draft: ${sanitiseBody(c.draft).replace(/\s+/g, ' ')}\n   Sent instead: ${sanitiseBody(c.finalText).replace(/\s+/g, ' ')}`,
  )
  return `${heading}\n<corrections>\n${items.join('\n')}\n</corrections>`
}
