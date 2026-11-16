// Pure team-number helpers. Safe to import from client and server code.
//
// Why this exists: team members often reply to clients from personal WhatsApp numbers, and va-bot stores
// those messages as direction = 'incoming'. The stored direction is unreliable, so every read derives the
// direction from the sender's number against the known team numbers.

export type Direction = 'incoming' | 'outgoing'

/** Digits only, last 10 (Indian mobile without country code). Null when fewer than 10 digits remain. */
export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 10) return null
  return digits.slice(-10)
}

/**
 * Builds the team number set from `vas.whatsapp_number` values plus the `settings` row
 * 'team_whatsapp_numbers' (comma separated; newlines, semicolons and spaces around entries are tolerated).
 */
export function parseTeamNumbers(vaNumbers: (string | null)[], settingValue: string | null): Set<string> {
  const out = new Set<string>()
  const add = (raw: string | null) => {
    const n = normalizePhone(raw)
    if (n) out.add(n)
  }
  vaNumbers.forEach(add)
  if (settingValue) settingValue.split(/[,;\n]+/).forEach((part) => add(part.trim()))
  return out
}

/**
 * The direction to use everywhere. A message is outgoing when its sender is a team number, or when
 * va-bot stored it as outgoing. Everything else (including a null stored direction) is incoming.
 */
export function effectiveDirection(
  m: { sender_phone: string | null; direction: string | null },
  team: Set<string>,
): Direction {
  const phone = normalizePhone(m.sender_phone)
  if (phone && team.has(phone)) return 'outgoing'
  if (m.direction?.trim().toLowerCase() === 'outgoing') return 'outgoing'
  return 'incoming'
}
