// Code checks on a drafted reply, run before anything is shown. Pure, so it is unit tested.
// The model is told the same rules; these checks do not trust it.
import type { ReplyItem } from './prompt'
import type { DraftReply, ReplyModelOutput } from './types'

export type GuardResult = { ok: true; draft: DraftReply } | { ok: false; reason: 'empty' | 'credential' }

export const MAX_REPLY_CHARS = 1000
export const MAX_CHECK_CHARS = 400
export const MAX_SOURCES = 12

/** Words after which the next token is the secret itself. */
const SECRET_KEY = /^(otp|password|passcode|pwd|pass|pin|cvv|mpin|tpin|userid|username|login)$/i
/** Words that sit between the key and the value ("password is X", "OTP: 1234", "pwd hai X"). */
const FILLER = /^(is|:|=|-|hai|h|ka|ki|ke|for|my|the|new|ye|yeh)$/i
/** Plain words that follow a key but are not a value ("password change", "OTP required"). */
const NOT_A_VALUE =
  /^(change|changed|reset|required|needed|incorrect|wrong|expired|sent|shared|share|send|kar|diya|please|not|nahi|aaya|received|bhejo|update|updated|link|portal|login|id)$/i
const BANK_WORDS = /\b(a\/c|acc(oun)?t\s*(no|number|num)?|card|ifsc|bank)\b/i
/** A credential stated with its value in the reply: the value has a digit or a symbol ("OTP is 4455", "pwd: ab@cd"). */
const CREDENTIAL_IN_TEXT = /\b(otp|password|passcode|pwd|cvv|mpin)\b\s*(is|:|=|-)?\s*(?=\S*[\d@#$%^&*!])\S{4,}/i
/** Form and period names that look like codes but are not references to check ("GSTR3B", "Form16A", "FY2026"). */
const COMMON_CODE = /^(gstr-?\d+[a-z]?|form-?\d+[a-z]*|fy\d{2,4}(-?\d{2,4})?|ay\d{2,4}(-?\d{2,4})?|\d{2}as|\d{2}q|itr-?\d+)$/i

function tokens(text: string): string[] {
  return text.split(/[\s,;()'"]+/).map((t) => t.replace(/^[:=-]+|[.:,!?]+$/g, '')).filter(Boolean)
}

const isYear = (t: string) => /^(19|20)\d{2}$/.test(t)

/**
 * Secret values found in the messages: the token after a credential word (skipping filler), when it looks like a
 * value; and long digit runs (9+) in messages about bank accounts or cards. Years and plain words are never secrets.
 */
export function secretTokens(items: ReplyItem[]): string[] {
  const out = new Set<string>()
  for (const i of items) {
    if (i.type !== 'message') continue
    const ts = tokens(i.text)
    ts.forEach((t, idx) => {
      if (!SECRET_KEY.test(t)) return
      let j = idx + 1
      while (j < ts.length && FILLER.test(ts[j])) j++
      const v = ts[j]
      if (!v || v.length < 4 || isYear(v) || NOT_A_VALUE.test(v) || SECRET_KEY.test(v)) return
      out.add(v)
    })
    if (BANK_WORDS.test(i.text)) for (const t of ts) if (/^\d{9,}$/.test(t)) out.add(t)
  }
  return [...out]
}

/** True when text states a credential value or repeats a secret from the messages (whole tokens only). */
export function leaksCredential(text: string, secrets: string[]): boolean {
  if (!text) return false
  if (CREDENTIAL_IN_TEXT.test(text)) return true
  const have = new Set(tokens(text))
  return secrets.some((s) => have.has(s))
}

/** Numbers and reference codes in the reply: "14,000", "02/11/2026", "4:10", "AA2910260012345". */
export function referenceTokens(reply: string): string[] {
  // Digit runs not glued to letters (so "Form16A" or "GSTR3B" is one code, not the number "16").
  const nums = reply.match(/(?<![A-Za-z\d])\d[\d,./:-]*\d(?![A-Za-z\d])/g) ?? []
  const codes = reply.match(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,}\b/g) ?? []
  return [...new Set([...nums, ...codes].map((t) => t.replace(/[.,:/-]+$/, '')))].filter((t) => !COMMON_CODE.test(t))
}

function normalise(s: string): string {
  return s.replace(/[,\s]/g, '').toLowerCase()
}

/** "2026-11-02T10:40Z" -> "02/11/2026 2/11/2026 02-11-2026 02.11.2026" in India time, so numeric dates verify. */
function numericDates(iso: string | null, timeZone: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  )
  const dd = p.day, mm = p.month, yy = p.year
  return [`${dd}/${mm}/${yy}`, `${Number(dd)}/${Number(mm)}/${yy}`, `${dd}-${mm}-${yy}`, `${dd}.${mm}.${yy}`].join(' ')
}

const cleanDashes = (s: string) => s.replace(/\s*—\s*/g, ', ').replace(/–/g, '-').trim()

export function checkDraft(raw: ReplyModelOutput, items: ReplyItem[], timeZone = 'Asia/Kolkata'): GuardResult {
  let reply = cleanDashes(raw.reply)
  if (!reply) return { ok: false, reason: 'empty' }

  // 1. Credentials: never show a draft that repeats one.
  const secrets = secretTokens(items)
  if (leaksCredential(reply, secrets)) return { ok: false, reason: 'credential' }

  const warnings: string[] = []
  let confidence = raw.confidence

  // The "check" note is model text too: same checks, and it is hidden (not the whole draft) when it leaks.
  let check: string | null = raw.check ? cleanDashes(raw.check).slice(0, MAX_CHECK_CHARS) || null : null
  if (check && leaksCredential(check, secrets)) {
    check = null
    warnings.push('A note from the AI was hidden because it contained sensitive details.')
  }

  // 2. Sources: only item numbers we actually gave the model.
  const byN = new Map(items.map((i) => [i.n, i]))
  const asked = [...new Set(raw.sources)].slice(0, MAX_SOURCES)
  const used = asked.filter((n) => byN.has(n))
  if (used.length < asked.length) warnings.push('The AI cited a source that does not exist; it was removed.')
  if (used.length === 0) {
    confidence = 'low'
    warnings.push('No source supports this draft. Check every fact before sending.')
  }

  // 3. Every number or reference code must appear in a cited source (text, label, attributes or its date).
  const haystack = normalise(
    used
      .map((n) => byN.get(n)!)
      .map((i) => [i.text, i.citation.label, ...Object.values(i.attrs), numericDates(i.citation.at, timeZone)].join(' '))
      .join(' '),
  )
  const unverified = referenceTokens(reply).filter((t) => !haystack.includes(normalise(t)))
  if (unverified.length > 0) {
    confidence = 'low'
    warnings.push(`Not found in the sources: ${unverified.slice(0, 5).join(', ')}. Check before sending.`)
  }

  if (reply.length > MAX_REPLY_CHARS) reply = `${reply.slice(0, MAX_REPLY_CHARS - 3).trimEnd()}...`
  return {
    ok: true,
    draft: { reply, sources: used.map((n) => byN.get(n)!.citation), confidence, check, warnings },
  }
}
