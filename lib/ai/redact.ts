// Hides credential values in text before it reaches an AI model, the browser (Ask AI tool output) or storage
// (council ticket titles and summaries). CLAUDE.md: never read, copy, store or echo client passwords or credentials.
// Pure and client-safe. Heuristic by design: it hides the VALUE next to a credential word, and long account or card
// numbers in bank or card messages, and leaves ordinary text alone ("OTP is required", "password changed").

export const HIDDEN = '[hidden]'

const KEY = String.raw`otp|one\s*time\s*password|password|passcode|pass\s*word|pwd|mpin|tpin|pin|cvv|user\s*id|userid|username|login\s*id`
/** key, then an optional joiner word or symbol, then the value. */
const KEY_VALUE = new RegExp(String.raw`\b(${KEY})\b(\s*(?:is|:|=|-|hai|h|ka|ki)?\s*(?:[:=-]\s*)?)([^\s,;()'"<>]+)`, 'gi')
const NOT_A_VALUE =
  /^(change|changed|reset|required|needed|incorrect|wrong|expired|sent|shared|share|send|kar|diya|please|not|nahi|aaya|received|bhejo|update|updated|link|portal|login|id|and|or|for|the|to|is|was|will|bhi|code|number|no)$/i
const BANK_WORDS = /\b(a\/c|acc(oun)?t\s*(no|number|num)?|card|ifsc|bank|debit|credit)\b/i
/** 9 to 19 digits, optionally in groups split by spaces or dashes (card style). */
const LONG_NUMBER = /\b\d(?:[\s-]?\d){8,18}\b/g

function isValue(v: string): boolean {
  const t = v.replace(/[.:!?]+$/, '')
  if (t.length < 4) return false
  if (/^(19|20)\d{2}$/.test(t)) return false
  return !NOT_A_VALUE.test(t)
}

export function maskCredentials(text: string | null | undefined): string {
  if (!text) return text ?? ''
  let out = text.replace(KEY_VALUE, (all, key: string, joiner: string, value: string) => {
    if (!isValue(value)) return all
    const trail = value.match(/[.:!?]+$/)?.[0] ?? ''
    return `${key}${joiner}${HIDDEN}${trail}`
  })
  if (BANK_WORDS.test(out)) out = out.replace(LONG_NUMBER, HIDDEN)
  return out
}

/** True when masking would change the text, i.e. it carries a credential value. */
export function hasCredential(text: string | null | undefined): boolean {
  return !!text && maskCredentials(text) !== text
}
