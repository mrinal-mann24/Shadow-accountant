// Display name helpers for the Client 360 header (client-safe, unit tested). Local copy on purpose: lib/data is
// owned elsewhere. The WhatsApp group name usually carries the business name plus our team tag, for example
// "Horizon Marketing <> VA" or "AI Accountant <> Horizon Marketing"; the tag is dropped for display.

/** Our side of a group name: "VA", "Virtual Accounting", "AI Accountant", optionally followed by "Team". */
const TEAM = String.raw`(?:ai\s*accountant(?:\s*virtual\s*accounting)?|virtual\s*accounting|va)(?:\s*team)?`
/** Joiners used between the business and our tag ("x" and "&" only as whole words). */
const JOIN = String.raw`(?:<\s*>|<->|<=>|\||-|:|\s(?:x|&)\s)`

const SUFFIX = new RegExp(String.raw`\s*${JOIN}\s*${TEAM}\s*$`, 'i')
const PREFIX = new RegExp(String.raw`^\s*${TEAM}\s*${JOIN}\s*`, 'i')

/** Business name for display: the WhatsApp group name without our team tag, else the client name. */
export function businessName(groupName: string | null | undefined, clientName: string): string {
  const raw = groupName?.trim()
  if (!raw) return clientName.trim() || clientName
  const cleaned = raw.replace(SUFFIX, '').replace(PREFIX, '').replace(/\s+/g, ' ').trim()
  return cleaned || clientName.trim() || clientName
}

/** Up to two initials from a name, letters and digits only ("Horizon Marketing" gives "HM"). */
export function initials(name: string): string {
  const words = name
    .split(/[\s\-_/.,&()]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
  if (words.length === 0) return '?'
  const picked = words.length === 1 ? [words[0].slice(0, 2)] : [words[0][0], words[1][0]]
  return picked.join('').toUpperCase()
}

/** Health label for the score ring, from the same bands as healthTone (75+ good, 50+ watch). */
export function healthLabel(score: number | null): string {
  if (score === null) return 'Not scored'
  if (score >= 75) return 'Healthy'
  if (score >= 50) return 'Watch'
  return 'At risk'
}

/** stroke-dashoffset for the ring (circumference 264 on r=42), score clamped to 0..100. */
export function ringOffset(score: number | null): number {
  if (score === null) return 264
  const s = Math.min(100, Math.max(0, score))
  return Math.round(264 * (1 - s / 100))
}
