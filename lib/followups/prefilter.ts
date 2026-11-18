// Cheap keyword prefilter for follow-ups, run before any model call. Pure and client-safe.
// Built for recall, not precision: a false "true" only costs one model call, a false "false" loses a promise,
// a document request or a repeat ask for good. The model (extract.ts) does the real decision.
// English, Hinglish and the usual WhatsApp shorthand ("tommo", "pls", "kal tak", "EOD").

/** Words that, alone, never carry a follow-up ("Ok sir", "Thanks", "Noted", "Good morning", "Received sir, thanks"). */
export const ACK_WORDS = [
  'ok', 'okay', 'okk', 'okie', 'k', 'kk', 'thanks', 'thank', 'thankyou', 'thx', 'ty', 'tq', 'tnx', 'you', 'u',
  'sir', 'mam', 'maam', "ma'am", 'madam', 'ji', 'bhai', 'dear', 'noted', 'sure', 'done', 'received', 'recd',
  'good', 'morning', 'afternoon', 'evening', 'night', 'gm', 'hi', 'hello', 'hey', 'hii', 'welcome', 'great',
  'fine', 'yes', 'yeah', 'ya', 'yup', 'haan', 'ha', 'han', 'theek', 'thik', 'hai', 'h', 'cool', 'alright',
  'np', 'regards', 'best', 'very', 'much', 'so', 'a', 'lot', 'all', 'the', 'and', 'nice', 'perfect', 'got', 'it',
  'shukriya', 'dhanyavaad', 'acha', 'accha', 'achha',
] as const

/** Promise verbs, English and Hinglish ("will share", "I'll send", "bhej dunga", "kar denge"). */
export const PROMISE_WORDS = [
  'will', 'shall', "i'll", "we'll", 'ill', 'gonna', 'going to', 'revert', 'get back', 'let you know', 'update you',
  'in progress', 'working on', 'ready', 'dunga', 'dungi', 'denge', 'karenge', 'karunga', 'kar dunga', 'kar denge',
  'bhej', 'bhejenge', 'bhejta', 'de dunga', 'dedunga', 'dedenge', 'ho jayega', 'hojayega', 'ho jaega', 'milega',
  'file kar', 'share kar',
] as const

/** Day and deadline words ("by tommo", "kal tak", "EOD", "by Monday"). */
export const TIME_WORDS = [
  'today', 'tonight', 'tomorrow', 'tommorow', 'tomorow', 'tommo', 'tomo', 'tmrw', 'tmr', '2moro', 'eod', 'eow',
  'eom', 'end of day', 'end of week', 'end of month', 'this week', 'next week', 'kal', 'aaj', 'parso', 'abhi',
  'asap', 'soon', 'shortly', 'few days', 'couple of days', 'within', 'tak', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat',
  'sun', 'deadline', 'due date',
] as const

/** Request phrases aimed at the client ("pls share", "kindly provide", "bhej dijiye"). */
export const REQUEST_WORDS = [
  'please', 'pls', 'plz', 'plss', 'kindly', 'request you', 'requesting', 'share', 'send', 'provide', 'upload',
  'forward', 'need', 'required', 'require', 'awaiting', 'yet to receive', 'pending from your side', 'dijiye',
  'dijie', 'de dijiye', 'bhejiye', 'bhejo', 'bhej do', 'chahiye',
] as const

/** Document words (what the team chases from the client). */
export const DOCUMENT_WORDS = [
  'document', 'documents', 'doc', 'docs', 'statement', 'statements', 'invoice', 'invoices', 'bill', 'bills',
  'ledger', 'ledgers', 'receipt', 'receipts', 'voucher', 'vouchers', 'bank', 'cc', 'credit card', 'gst', 'gstr',
  'tds', 'tcs', 'pan', 'aadhaar', 'aadhar', 'form 16', 'form16', 'form 26as', '26as', 'ais', 'challan', 'challans',
  'register', 'sales', 'purchase', 'purchases', 'payroll', 'salary', 'salaries', 'payslip', 'agreement',
  'contract', 'rent', 'loan', 'emi', 'certificate', 'copy', 'copies', 'excel', 'sheet', 'pdf', 'report', 'mis',
  'p&l', 'pnl', 'balance sheet', 'financials', 'itr', 'return', 'returns', 'working', 'reconciliation', 'brs',
  'stock', 'inventory', 'expense', 'expenses', 'debit note', 'credit note', 'e-way', 'eway', 'deed', 'msme',
  'udyam', 'cheque', 'passbook',
] as const

/** Repeat-ask words ("any update", "still waiting", "kab tak", "reminder"). */
export const REPEAT_WORDS = [
  'when', 'still', 'any update', 'update', 'updates', 'status', 'waiting', 'wait', 'again', 'reminder', 'remind',
  'yet', 'pending', 'follow up', 'followup', 'follow-up', 'kab', 'kab tak', 'abhi tak', 'ab tak', 'kya hua',
  'kitna time', 'how long', 'eta', 'asap', 'urgent', 'urgently', 'chasing', 'not received', "haven't received",
  'have not received', 'nahi mila', 'nhi mila', 'nahi aaya', 'nhi aaya', 'not done', 'delay', 'delayed', 'already',
  'last week', 'pichle', 'bola tha', 'told', 'asked', 'puch', 'pucha', 'what happened', 'progress', 'done?',
] as const

/** Holding replies: the team acknowledges a question without answering it yet. */
export const HOLDING_WORDS = [
  'will check', 'checking', 'let me check', 'will revert', 'will get back', 'give me some time', 'give me a day',
  'looking into it', 'looking into this', 'dekhte hain', 'dekhta hu', 'dekhta hoon', 'check karke', 'check kar ke',
] as const

/** Words that show a reply carries the answer or the thing itself ("Checking... it is filed, ARN attached"). */
export const ANSWER_WORDS = [
  'done', 'filed', 'completed', 'shared', 'sent', 'attached', 'here is', 'here are', 'please find', 'pfa',
  'submitted', 'paid', 'uploaded', 'ho gaya', 'hogaya', 'kar diya', 'bhej diya', 'bhej di',
] as const

/** A short question (at most this many words ending in "?") counts as a possible repeat ask. */
export const SHORT_ASK_MAX_WORDS = 20

function escape(w: string): string {
  return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One case-insensitive regex for a word list, on word edges (letters, digits and & count as word characters). */
function wordsRegex(words: readonly string[]): RegExp {
  const alt = [...words].sort((a, b) => b.length - a.length).map((w) => escape(w).replace(/ /g, '\\s+')).join('|')
  return new RegExp(`(?<![\\p{L}\\p{N}&])(?:${alt})(?![\\p{L}\\p{N}&])`, 'iu')
}

const PROMISE_RE = wordsRegex(PROMISE_WORDS)
const TIME_RE = wordsRegex(TIME_WORDS)
const REQUEST_RE = wordsRegex(REQUEST_WORDS)
const DOCUMENT_RE = wordsRegex(DOCUMENT_WORDS)
const REPEAT_RE = wordsRegex(REPEAT_WORDS)
const HOLDING_RE = wordsRegex(HOLDING_WORDS)
const ANSWER_RE = wordsRegex(ANSWER_WORDS)
/** "25th", "1st", "25/11", "25.11.2026", "25-11". */
const DATE_RE = /(?<!\d)(?:\d{1,2}(?:st|nd|rd|th)|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)(?![\p{L}\p{N}])/iu
const ACK = new Set<string>(ACK_WORDS)

/** Lowercase words of a message with emojis, symbols and punctuation dropped. */
function words(body: string): string[] {
  return body
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'&?\s]/gu, ' ')
    .replace(/\?/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * True for empty text, emojis only, or acknowledgements only ("Ok sir", "Thanks 🙏", "Noted", "Good morning").
 * A question mark makes it a question, not an acknowledgement ("Done?").
 */
export function isAckOnly(body: string | null | undefined): boolean {
  const text = body ?? ''
  if (text.includes('?')) return false
  return words(text).every((x) => ACK.has(x))
}

/**
 * True for a holding reply ("Will check and revert", "Checking sir", "Let me check", "dekhte hain"): a holding
 * phrase and nothing that reads like the answer itself. Such a reply does not answer a repeat ask.
 */
export function isHoldingReply(body: string | null | undefined): boolean {
  const text = (body ?? '').trim()
  if (!text) return false
  return HOLDING_RE.test(text) && !ANSWER_RE.test(text)
}

/** Could this TEAM message hold a promise or a document request? High recall. */
export function mightBeTeamFollowUp(body: string | null | undefined): boolean {
  const text = (body ?? '').trim()
  if (!text || isAckOnly(text)) return false
  return PROMISE_RE.test(text) || TIME_RE.test(text) || DATE_RE.test(text) || REQUEST_RE.test(text) || DOCUMENT_RE.test(text)
}

/** Could this CLIENT message be a repeat ask ("Any update?", "Still waiting", "kab tak milega")? High recall. */
export function mightBeRepeatAsk(body: string | null | undefined): boolean {
  const text = (body ?? '').trim()
  if (!text || isAckOnly(text)) return false
  if (REPEAT_RE.test(text)) return true
  return /\?\s*$/u.test(text.replace(/[\p{Extended_Pictographic}️‍\s]+$/gu, '')) && words(text).length <= SHORT_ASK_MAX_WORDS
}
