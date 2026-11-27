// Hides credential values in text before it reaches an AI model, the browser (Ask AI tool output) or storage
// (council ticket titles and summaries). CLAUDE.md: never read, copy, store or echo client passwords or credentials.
// Pure and client-safe. Heuristic by design:
//   * the VALUE after a credential word is hidden ("OTP is 445566", 'password: "Ab,c@1"', "pin number 1234")
//   * account or card numbers right after "a/c", "account" or "card" are hidden
// and ordinary accounting text is left alone ("OTP is required", "PIN code 560001", ARN, CPIN, challan, ITC numbers).
// A linear scan (no nested regex quantifiers), so a long message cannot make it slow.

export const HIDDEN = '[hidden]'

/** Credential words. "pass" only counts when followed by ":" or "=" ("pass: x"), never in "pass the entry". */
const KEY = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(one\s?time\s?password|otp|password|passwrd|paswrd|pass\s?word|passcode|pswd|pwd|pass(?=\s*[:=])|upi\s?pin|mpin|tpin|atm\s?pin|pin|cvv|user\s?id|userid|username|user\s?name|login\s?id|net\s?banking\s?id|customer\s?id|crn|पासवर्ड|ओटीपी)(?![\p{L}\p{N}])`,
  'giu',
)
/** Same words, non-global (safe for .test() inside the scan, which uses KEY.lastIndex). */
const IS_KEY = new RegExp(KEY.source, 'iu')
/** Words that may sit between the key and the value. */
const FILLER = /^(is|was|hai|h|hain|ka|ki|ke|yeh|ye|ya|my|mera|meri|the|new|naya|number|no|num|code|for|:|=|-|–)$/iu
/** Words that show there is no value ("OTP is required", "password reset link sent"). */
const NO_VALUE =
  /^(change|changed|reset|required|needed|incorrect|wrong|expired|expire|expires|sent|shared|share|send|kar|karo|diya|please|pls|not|nahi|nhi|aaya|aya|received|bhejo|bhej|update|updated|link|portal|login|and|or|to|will|bhi|mil|gaya|ho|hoga|chahiye|ok|okay|verified|generated|request|requested|via|on|from|through|sms|email|mail|bata|batao|goes|go|going|comes|come|coming|arrives|arrive|reaches|reach|needs)$/iu
const MAX_FILLERS = 2

/** Account or card number right after "a/c", "account (no)" or "card": 9 to 18 digits, or 4-4-4-4 card groups. */
const ACCOUNT_NUMBER =
  /(\b(?:a\/c|acc(?:oun)?t|card)\b(?:\s*(?:no|number|num)\b)?[^\d\n]{0,12})(\d{9,18}|\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?)(?!\d)/giu

type Token = { start: number; end: number; text: string; quoted: boolean }

/** Next token at or after `i`: a quoted string, or a run of non-space characters (trailing punctuation dropped). */
function nextToken(s: string, i: number): Token | null {
  let p = i
  while (p < s.length && /\s/.test(s[p])) p++
  if (p >= s.length) return null
  const q = s[p]
  if (q === '"' || q === "'" || q === '“' || q === '‘') {
    const close = q === '“' ? '”' : q === '‘' ? '’' : q
    const end = s.indexOf(close, p + 1)
    if (end > p + 1 && end - p < 200) return { start: p, end: end + 1, text: s.slice(p + 1, end), quoted: true }
  }
  // Leading ":" "=" "-" are joiners, not part of the value.
  if (/[:=\-–]/.test(q)) return { start: p, end: p + 1, text: q, quoted: false }
  let e = p
  while (e < s.length && !/\s/.test(s[e]) && s[e] !== '<' && s[e] !== '>') e++
  let text = s.slice(p, e)
  const trimmed = text.replace(/[.,;!?)\]]+$/u, '')
  e -= text.length - trimmed.length
  text = trimmed
  return { start: p, end: e, text, quoted: false }
}

export function maskCredentials(text: string | null | undefined): string {
  if (!text) return text ?? ''
  const cuts: { start: number; end: number }[] = []
  KEY.lastIndex = 0
  for (let m = KEY.exec(text); m; m = KEY.exec(text)) {
    const key = m[1].toLowerCase()
    let at = m.index + m[0].length
    let tok = nextToken(text, at)
    // "PIN code 560001" is a postal code, not a credential.
    if (key === 'pin' && tok && /^code$/i.test(tok.text)) continue
    let fillers = 0
    while (tok && !tok.quoted && FILLER.test(tok.text) && fillers < MAX_FILLERS + 1) {
      at = tok.end
      tok = nextToken(text, at)
      fillers++
    }
    if (!tok || !tok.text) continue
    // Already masked (text masked when stored, then again when shown): leave it, or "[hidden]" becomes "[hidden]]".
    if (!tok.quoted && tok.text.startsWith(HIDDEN.slice(0, -1))) {
      KEY.lastIndex = tok.end
      continue
    }
    if (!tok.quoted && (NO_VALUE.test(tok.text) || FILLER.test(tok.text) || IS_KEY.test(` ${tok.text} `))) {
      KEY.lastIndex = at
      continue
    }
    if (!tok.quoted && tok.text.length < 3) continue
    if (!tok.quoted && /^(19|20)\d{2}$/.test(tok.text)) continue
    cuts.push({ start: tok.quoted ? tok.start + 1 : tok.start, end: tok.quoted ? tok.end - 1 : tok.end })
    KEY.lastIndex = tok.end
  }
  let out = text
  for (const c of cuts.sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + HIDDEN + out.slice(c.end)
  return out.replace(ACCOUNT_NUMBER, (_all, lead: string) => `${lead}${HIDDEN}`)
}

const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g

/**
 * Hides PAN and GSTIN numbers in text the AI writes (ticket titles and summaries, Teams cards), so a client's tax ids
 * are not repeated outside the chat they were sent in: "[GSTIN]", "[PAN]". Client messages themselves are not changed.
 */
export function maskTaxIds(text: string): string {
  return text.replace(GSTIN, '[GSTIN]').replace(PAN, '[PAN]')
}

/** maskCredentials for optional fields: null and undefined stay as they are. */
export function maskNullable<T extends string | null | undefined>(text: T): T {
  return (text == null ? text : maskCredentials(text)) as T
}

/** True when masking would change the text, i.e. it carries a credential value. */
export function hasCredential(text: string | null | undefined): boolean {
  return !!text && maskCredentials(text) !== text
}
