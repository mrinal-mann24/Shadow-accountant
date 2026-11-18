// Labelled eval set for the follow-up extractor (extract.ts) and the prefilter (prefilter.ts). Pure, no secrets.
// Realistic WhatsApp lines (English, Hinglish, typos); names and numbers are made up.
// Labels follow the decisions at the top of prompt.ts. Every team case uses TODAY = 2026-11-18 (a Wednesday), so
// tomorrow = 2026-11-19, Friday = 2026-11-20, coming Saturday (EOW) = 2026-11-21, Monday = 2026-11-23.
// Expected items are short key phrases; scoreCase compares loosely (item count and keyword overlap, due_date exact).
import type { ClientExtraction, DeliveryCheck, FollowUpKind, OpenItem, ScanMessage, TeamExtraction } from './types'

export const EVAL_TODAY = '2026-11-18'
const AT = '2026-11-18T06:30:00Z' // 12:00 IST

export type EvalContextMessage = { id?: string; from: 'team' | 'client'; body: string; at?: string }

export type TeamCase = { id: string; kind: 'team'; input: string; today?: string; context?: EvalContextMessage[]; expected: TeamExtraction }
export type ClientCase = { id: string; kind: 'client'; input: string; context?: EvalContextMessage[]; open?: OpenItem[]; expected: ClientExtraction }
export type DeliveryCase = { id: string; kind: 'delivery'; input: string; evidence: 'message' | 'file'; open: OpenItem[]; expected: DeliveryCheck }
export type EvalCase = TeamCase | ClientCase | DeliveryCase

const P = (item: string, due_date: string | null = null): TeamExtraction['promises'][number] => ({ item, due_date, due_time: null })
const D = (item: string) => ({ item })
const team = (promises: TeamExtraction['promises'], document_requests: { item: string }[] = []): TeamExtraction => ({ promises, document_requests })
const NONE = team([])
const open = (id: string, kind: FollowUpKind, item: string): OpenItem => ({ id, kind, item, created_at: '2026-11-14T06:30:00Z' })

export const EVAL_CASES: EvalCase[] = [
  // ------------------------------------------------------------ team: promises and document requests
  {
    id: 't01-tommo',
    kind: 'team',
    input: 'We will give this by tommo Sir',
    context: [{ id: 'm-t01a', from: 'client', body: 'Please send the P&L for October', at: '2026-11-18T05:00:00Z' }],
    expected: team([P('P&L', '2026-11-19')]),
  },
  {
    id: 't02-doc-list',
    kind: 'team',
    input: 'Hi sir Please share following documents for the month of Oct: Personal Bank statements, CC statements, Ledger statement till 31.10.2026',
    expected: team([], [D('personal bank statement'), D('credit card statement'), D('ledger statement')]),
  },
  {
    id: 't03-mis-then-dashboard',
    kind: 'team',
    input: 'Here is the MIS for your reference, Will share you the dashboard in few days',
    expected: team([P('dashboard')]),
  },
  {
    id: 't04-check-and-revert',
    kind: 'team',
    input: 'Will check and revert sir',
    context: [{ id: 'm-t04a', from: 'client', body: 'Why is the ITC lower this month?', at: '2026-11-18T05:00:00Z' }],
    expected: team([P('ITC')]),
  },
  { id: 't05-by-20th', kind: 'team', input: 'GSTR-3B will be filed by 20th sir', expected: team([P('GSTR-3B', '2026-11-20')]) },
  { id: 't06-kal-tak-hinglish', kind: 'team', input: 'Sir kal tak bhej dunga balance sheet', expected: team([P('balance sheet', '2026-11-19')]) },
  { id: 't07-aaj-eod', kind: 'team', input: 'Aaj EOD tak reconciliation complete kar denge', expected: team([P('reconciliation', '2026-11-18')]) },
  { id: 't08-kindly-upload', kind: 'team', input: 'Kindly upload the purchase invoices for Nov on the drive pls', expected: team([], [D('purchase invoices')]) },
  { id: 't09-form16-rent', kind: 'team', input: 'Pls share Form 16 and rent receipts for ITR', expected: team([], [D('Form 16'), D('rent receipts')]) },
  {
    id: 't10-two-promises-monday',
    kind: 'team',
    input: 'We will update the books by Monday and share the P&L',
    expected: team([P('books', '2026-11-23'), P('P&L', '2026-11-23')]),
  },
  { id: 't11-ddmm', kind: 'team', input: 'Will send the TDS challan by 25/11', expected: team([P('TDS challan', '2026-11-25')]) },
  {
    id: 't12-hdfc-and-loan',
    kind: 'team',
    input: 'Sir please provide the bank statement of HDFC current account from April to Oct, also the loan statement',
    expected: team([], [D('HDFC bank statement'), D('loan statement')]),
  },
  { id: 't13-time-today', kind: 'team', input: 'Noted sir, will share the revised invoice by 5 pm today', expected: team([P('revised invoice', '2026-11-18')]) },
  { id: 't14-vendor-ledger', kind: 'team', input: 'Payment ledger of vendor ABC is pending from your side, please send it', expected: team([], [D('ABC ledger')]) },
  {
    id: 't15-eow',
    kind: 'team',
    input: 'will revert on this by EOW',
    context: [{ id: 'm-t15a', from: 'client', body: 'We got a TDS notice for Q2, what should we do?', at: '2026-11-18T05:00:00Z' }],
    expected: team([P('TDS notice', '2026-11-21')]),
  },
  {
    id: 't16-sales-register',
    kind: 'team',
    input: 'Dear sir, we are yet to receive the sales register for October. Kindly share at the earliest.',
    expected: team([], [D('sales register')]),
  },
  { id: 't17-friday', kind: 'team', input: 'Will file the TDS return on Friday sir', expected: team([P('TDS return', '2026-11-20')]) },
  { id: 't18-30th-nov', kind: 'team', input: 'Draft financials will be ready by 30th Nov', expected: team([P('draft financials', '2026-11-30')]) },
  {
    id: 't19-pan-aadhaar-hinglish',
    kind: 'team',
    input: 'Sir director ka pan card copy aur aadhaar bhej dijiye',
    expected: team([], [D('PAN card'), D('Aadhaar')]),
  },
  {
    id: 't20-tmrw-two',
    kind: 'team',
    input: 'we will complete the entries tmrw and send you the updated ledger',
    expected: team([P('entries', '2026-11-19'), P('ledger', '2026-11-19')]),
  },
  {
    id: 't21-promise-and-request',
    kind: 'team',
    input: 'Will prepare the GST working by Friday, pls send the purchase bills of Nov meanwhile',
    expected: team([P('GST working', '2026-11-20')], [D('purchase bills')]),
  },
  {
    id: 't22-parso',
    kind: 'team',
    input: 'Ji sir parso tak payroll process ho jayega',
    expected: team([P('payroll', '2026-11-20')]),
  },

  // ------------------------------------------------------------ team: negatives
  { id: 'n01-ok-sir', kind: 'team', input: 'Ok sir', expected: NONE },
  { id: 'n02-thanks-emoji', kind: 'team', input: 'Thank you sir 🙏', expected: NONE },
  { id: 'n03-noted', kind: 'team', input: 'Noted', expected: NONE },
  { id: 'n04-good-morning', kind: 'team', input: 'Good morning sir', expected: NONE },
  { id: 'n05-bare-will-check', kind: 'team', input: 'Will check sir', expected: NONE },
  { id: 'n06-team-file-attached', kind: 'team', input: 'Please find attached the GST working for October', expected: NONE },
  { id: 'n07-here-is-brs', kind: 'team', input: 'Here is the bank reconciliation statement for Oct', expected: NONE },
  { id: 'n08-already-filed', kind: 'team', input: 'We have filed the GSTR-1 for October, ARN attached', expected: NONE },
  { id: 'n09-thumbs', kind: 'team', input: '👍', expected: NONE },
  { id: 'n10-received', kind: 'team', input: 'Received sir, thanks', expected: NONE },
  { id: 'n11-period-date', kind: 'team', input: 'The ledger statement till 31.10.2026 shows a difference of Rs 4,500', expected: NONE },
  { id: 'n12-otp-not-document', kind: 'team', input: 'Please share the OTP received on your phone for GST portal login', expected: NONE },
  { id: 'n13-checking', kind: 'team', input: 'checking sir', expected: NONE },
  { id: 'n14-question', kind: 'team', input: 'Sir what is this payment of Rs 12,000 to Sharma Traders for?', expected: NONE },

  // ------------------------------------------------------------ client: repeat asks
  {
    id: 'c01-when-will-this-happen',
    kind: 'client',
    input: 'When will this happen?',
    context: [
      { id: 'm-c01a', from: 'client', body: 'Please get the GST registration amended for our new office address', at: '2026-11-14T05:00:00Z' },
      { id: 'm-c01b', from: 'team', body: 'Sure sir, will do', at: '2026-11-14T05:30:00Z' },
    ],
    expected: { repeat_ask: { item: 'GST registration address amendment', repeats_message_id: 'm-c01a' } },
  },
  {
    id: 'c02-any-update-gst',
    kind: 'client',
    input: 'Any update on the GST filing?',
    context: [{ id: 'm-c02a', from: 'client', body: 'Has the GST for Oct been filed?', at: '2026-11-17T05:00:00Z' }],
    expected: { repeat_ask: { item: 'GST filing', repeats_message_id: 'm-c02a' } },
  },
  { id: 'c03-any-update-no-history', kind: 'client', input: 'Any update on the GST filing?', expected: { repeat_ask: null } },
  {
    id: 'c04-still-waiting-open',
    kind: 'client',
    input: 'Still waiting for the P&L',
    open: [open('fu-c04', 'promise', 'Share P&L for October')],
    expected: { repeat_ask: { item: 'P&L', repeats_message_id: null } },
  },
  {
    id: 'c05-kab-milega-hinglish',
    kind: 'client',
    input: 'Bhai MIS kab tak milega? Pichle hafte bola tha',
    open: [open('fu-c05', 'promise', 'Share MIS for October')],
    expected: { repeat_ask: { item: 'MIS', repeats_message_id: null } },
  },
  { id: 'c06-thanks-received', kind: 'client', input: 'Thanks, received', expected: { repeat_ask: null } },
  { id: 'c07-ok', kind: 'client', input: 'Ok', expected: { repeat_ask: null } },
  { id: 'c08-new-request', kind: 'client', input: 'Can you also prepare the TDS working for Q3?', expected: { repeat_ask: null } },
  { id: 'c09-client-sends-file', kind: 'client', input: 'Sharing the bank statements', expected: { repeat_ask: null } },
  {
    id: 'c10-reminder-invoice',
    kind: 'client',
    input: 'reminder: need the invoice copy for XYZ Exports urgently',
    context: [
      { id: 'm-c10a', from: 'client', body: 'Please send me the invoice copy for XYZ Exports', at: '2026-11-16T05:00:00Z' },
      { id: 'm-c10b', from: 'team', body: 'Will share sir', at: '2026-11-16T05:20:00Z' },
    ],
    expected: { repeat_ask: { item: 'XYZ invoice copy', repeats_message_id: 'm-c10a' } },
  },
  {
    id: 'c11-already-answered',
    kind: 'client',
    input: 'Any update?',
    context: [
      { id: 'm-c11a', from: 'client', body: 'Has the income tax refund come?', at: '2026-11-16T05:00:00Z' },
      { id: 'm-c11b', from: 'team', body: 'Yes sir, the refund of Rs 18,400 was credited on 15th, please check your SBI account', at: '2026-11-16T06:00:00Z' },
    ],
    expected: { repeat_ask: null },
  },
  { id: 'c12-first-question', kind: 'client', input: 'Is the payroll done for this month?', expected: { repeat_ask: null } },
  {
    id: 'c13-third-time-itr',
    kind: 'client',
    input: 'Kab tak hoga ITR filing? 3rd time puch raha hu',
    context: [
      { id: 'm-c13a', from: 'client', body: 'ITR kab file hoga?', at: '2026-11-10T05:00:00Z' },
      { id: 'm-c13b', from: 'client', body: 'ITR ka kya hua?', at: '2026-11-14T05:00:00Z' },
    ],
    expected: { repeat_ask: { item: 'ITR filing', repeats_message_id: 'm-c13a' } },
  },
  { id: 'c14-good-morning', kind: 'client', input: 'Good morning 🙏', expected: { repeat_ask: null } },
  {
    id: 'c15-status-after-holding-reply',
    kind: 'client',
    input: 'status of the TDS refund?',
    context: [
      { id: 'm-c15a', from: 'client', body: 'TDS refund status please?', at: '2026-11-15T05:00:00Z' },
      { id: 'm-c15b', from: 'team', body: 'checking sir', at: '2026-11-15T05:30:00Z' },
    ],
    expected: { repeat_ask: { item: 'TDS refund', repeats_message_id: 'm-c15a' } },
  },

  // ------------------------------------------------------------ delivery checks
  {
    id: 'd01-bank-statement-file',
    kind: 'delivery',
    evidence: 'file',
    input: 'HDFC_Bank_Statement_Oct2026.pdf',
    open: [open('fu-d01a', 'document', 'Personal bank statement October'), open('fu-d01b', 'document', 'Credit card statement October'), open('fu-d01c', 'promise', 'Share MIS dashboard')],
    expected: { delivered_ids: ['fu-d01a'] },
  },
  {
    id: 'd02-here-is-mis',
    kind: 'delivery',
    evidence: 'message',
    input: 'Here is the MIS for your reference',
    open: [open('fu-d02a', 'promise', 'Share MIS for October'), open('fu-d02b', 'document', 'Purchase invoices November')],
    expected: { delivered_ids: ['fu-d02a'] },
  },
  {
    id: 'd03-generic-image',
    kind: 'delivery',
    evidence: 'file',
    input: 'IMG-20261118-WA0003.jpg',
    open: [open('fu-d03a', 'document', 'Bank statement October')],
    expected: { delivered_ids: [] },
  },
  {
    id: 'd04-future-promise',
    kind: 'delivery',
    evidence: 'message',
    input: 'Will share tomorrow sir',
    open: [open('fu-d04a', 'promise', 'Share P&L for October')],
    expected: { delivered_ids: [] },
  },
  {
    id: 'd05-cc-file',
    kind: 'delivery',
    evidence: 'file',
    input: 'ICICI_CreditCard_Statement_Oct.pdf',
    open: [open('fu-d05a', 'document', 'Credit card statement October'), open('fu-d05b', 'document', 'Bank statement October')],
    expected: { delivered_ids: ['fu-d05a'] },
  },
  {
    id: 'd06-form16-file',
    kind: 'delivery',
    evidence: 'file',
    input: 'Form16_FY2025-26.pdf',
    open: [open('fu-d06a', 'document', 'Form 16'), open('fu-d06b', 'document', 'Rent receipts')],
    expected: { delivered_ids: ['fu-d06a'] },
  },
  {
    id: 'd07-both-in-message',
    kind: 'delivery',
    evidence: 'message',
    input: 'Sharing rent receipts and Form 16 both',
    open: [open('fu-d07a', 'document', 'Form 16'), open('fu-d07b', 'document', 'Rent receipts')],
    expected: { delivered_ids: ['fu-d07a', 'fu-d07b'] },
  },
  {
    id: 'd08-team-filed-file',
    kind: 'delivery',
    evidence: 'file',
    input: 'GSTR3B_Oct2026_filed_acknowledgement.pdf',
    open: [open('fu-d08a', 'promise', 'File GSTR-3B for October'), open('fu-d08b', 'document', 'Sales register October')],
    expected: { delivered_ids: ['fu-d08a'] },
  },
  {
    id: 'd09-thanks',
    kind: 'delivery',
    evidence: 'message',
    input: 'Thanks sir',
    open: [open('fu-d09a', 'promise', 'Share dashboard')],
    expected: { delivered_ids: [] },
  },
  {
    id: 'd10-unrelated-file',
    kind: 'delivery',
    evidence: 'file',
    input: 'Invoice_XYZ_1234.pdf',
    open: [open('fu-d10a', 'document', 'Bank statement October')],
    expected: { delivered_ids: [] },
  },
  {
    id: 'd11-balance-sheet-attached',
    kind: 'delivery',
    evidence: 'message',
    input: 'Balance sheet attached sir, please review',
    open: [open('fu-d11a', 'promise', 'Send balance sheet'), open('fu-d11b', 'promise', 'File TDS return')],
    expected: { delivered_ids: ['fu-d11a'] },
  },
  {
    id: 'd12-vendor-ledger-file',
    kind: 'delivery',
    evidence: 'file',
    input: 'Ledger_ABC_Traders.xlsx',
    open: [open('fu-d12a', 'document', 'Vendor ABC ledger'), open('fu-d12b', 'document', 'Sales register October')],
    expected: { delivered_ids: ['fu-d12a'] },
  },
]

// ---------------------------------------------------------------- helpers for the runner and the tests

/** The case's input as the ScanMessage the extractor sees. */
export function caseMessage(c: TeamCase | ClientCase): ScanMessage {
  return {
    message_id: `m-${c.id}`,
    client_id: 'eval-client',
    conversation_id: null,
    body: c.input,
    direction: c.kind === 'team' ? 'outgoing' : 'incoming',
    sender_name: c.kind === 'team' ? 'Priya (team)' : 'Ravi (client)',
    message_timestamp: AT,
  }
}

/** The case's context as ScanMessages, oldest first. */
export function caseContext(c: TeamCase | ClientCase): ScanMessage[] {
  return (c.context ?? []).map((m, i) => ({
    message_id: m.id ?? `m-${c.id}-ctx${i}`,
    client_id: 'eval-client',
    conversation_id: null,
    body: m.body,
    direction: m.from === 'team' ? 'outgoing' : 'incoming',
    sender_name: m.from === 'team' ? 'Priya (team)' : 'Ravi (client)',
    message_timestamp: m.at ?? '2026-11-17T06:30:00Z',
  }))
}

/** True when a case expects at least one item (the prefilter must let it through). */
export function isPositive(c: EvalCase): boolean {
  if (c.kind === 'team') return c.expected.promises.length + c.expected.document_requests.length > 0
  if (c.kind === 'client') return c.expected.repeat_ask !== null
  return c.expected.delivered_ids.length > 0
}

// ---------------------------------------------------------------- loose scorer

const STOP = new Set([
  'the', 'and', 'for', 'of', 'to', 'on', 'in', 'by', 'from', 'our', 'your', 'you', 'sir', 'please', 'pls', 'kindly',
  'will', 'with', 'a', 'an', 'till', 'upto', 'month', 'copy', 'share', 'send', 'give', 'provide', 'upload', 'deliver',
  'submit', 'get', 'revert', 'check', 'back', 'complete', 'prepare', 'update', 'file', 'filing', 'filed', 'all', 'this',
  'that', 'about', 'status', 'regarding', 'client', 'shar', 'fil', 'it',
])

const PHRASES: [RegExp, string][] = [
  [/profit\s*(?:and|&)\s*loss|p\s*&\s*l|\bpnl\b/g, ' pl '],
  [/\bcc\b|credit\s*card|creditcard/g, ' credit card '],
  [/gstr\s*-?\s*3b/g, ' gstr3b '],
  [/gstr\s*-?\s*1\b/g, ' gstr1 '],
  [/form\s*-?\s*16/g, ' form16 '],
  [/aadhar/g, 'aadhaar'],
  [/\bbrs\b/g, ' bank reconciliation '],
]
const MONTHS: Record<string, string> = {
  january: 'jan', february: 'feb', march: 'mar', april: 'apr', june: 'jun', july: 'jul', august: 'aug',
  september: 'sep', sept: 'sep', october: 'oct', november: 'nov', december: 'dec',
}

function stem(w: string): string {
  let s = MONTHS[w] ?? w
  if (s.length > 3 && s.endsWith('s')) s = s.slice(0, -1)
  for (const suf of ['ment', 'ing', 'ed', 'e']) if (s.length - suf.length >= 3 && s.endsWith(suf)) return s.slice(0, -suf.length)
  return s
}

/** Content keywords of an item, normalised (synonyms, months, plurals, light stemming). */
export function keywords(text: string): Set<string> {
  let s = ` ${text.toLowerCase()} `
  for (const [re, to] of PHRASES) s = s.replace(re, to)
  const out = new Set<string>()
  for (const w of s.split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOP.has(w)) continue
    const k = stem(w)
    if (k && !STOP.has(k)) out.add(k)
  }
  return out
}

/** Share of the expected item's keywords found in the actual item (0..1). */
export function overlap(expected: string, actual: string): number {
  const e = keywords(expected)
  if (!e.size) return 0
  const a = keywords(actual)
  let n = 0
  for (const k of e) if (a.has(k)) n++
  return n / e.size
}

/** Above this share an expected item matches an actual item. Strictly more than half. */
export const MATCH_THRESHOLD = 0.5

export type Counts = { tp: number; fp: number; fn: number }
export type CaseScore = {
  pass: boolean
  promises: Counts
  documents: Counts
  repeat: Counts & { tn: number }
  delivered: Counts
  dueDates: { checked: number; right: number }
  notes: string[]
}

/** Greedy best-overlap matching. Returns pairs (expected index, actual index). */
function matchItems(expected: string[], actual: string[]): [number, number][] {
  const pairs: { e: number; a: number; s: number }[] = []
  expected.forEach((x, e) => actual.forEach((y, a) => {
    const s = overlap(x, y)
    if (s > MATCH_THRESHOLD) pairs.push({ e, a, s })
  }))
  pairs.sort((p, q) => q.s - p.s)
  const ue = new Set<number>()
  const ua = new Set<number>()
  const out: [number, number][] = []
  for (const p of pairs) {
    if (ue.has(p.e) || ua.has(p.a)) continue
    ue.add(p.e)
    ua.add(p.a)
    out.push([p.e, p.a])
  }
  return out
}

const zero = (): Counts => ({ tp: 0, fp: 0, fn: 0 })

/** Scores one case. `actual` is the extractor's output for that case kind. */
export function scoreCase(c: EvalCase, actual: TeamExtraction | ClientExtraction | DeliveryCheck): CaseScore {
  const s: CaseScore = { pass: true, promises: zero(), documents: zero(), repeat: { ...zero(), tn: 0 }, delivered: zero(), dueDates: { checked: 0, right: 0 }, notes: [] }
  if (c.kind === 'team') {
    const a = actual as TeamExtraction
    const pm = matchItems(c.expected.promises.map((p) => p.item), a.promises.map((p) => p.item))
    s.promises = { tp: pm.length, fp: a.promises.length - pm.length, fn: c.expected.promises.length - pm.length }
    for (const [e, i] of pm) {
      s.dueDates.checked++
      if (c.expected.promises[e].due_date === a.promises[i].due_date) s.dueDates.right++
      else s.notes.push(`due_date for "${a.promises[i].item}": expected ${c.expected.promises[e].due_date}, got ${a.promises[i].due_date}`)
    }
    const dm = matchItems(c.expected.document_requests.map((d) => d.item), a.document_requests.map((d) => d.item))
    s.documents = { tp: dm.length, fp: a.document_requests.length - dm.length, fn: c.expected.document_requests.length - dm.length }
    if (s.promises.fp || s.promises.fn) s.notes.push(`promises: expected [${c.expected.promises.map((p) => p.item).join('; ')}], got [${a.promises.map((p) => p.item).join('; ')}]`)
    if (s.documents.fp || s.documents.fn) s.notes.push(`documents: expected [${c.expected.document_requests.map((d) => d.item).join('; ')}], got [${a.document_requests.map((d) => d.item).join('; ')}]`)
    s.pass = !s.promises.fp && !s.promises.fn && !s.documents.fp && !s.documents.fn && s.dueDates.right === s.dueDates.checked
  } else if (c.kind === 'client') {
    const a = (actual as ClientExtraction).repeat_ask
    const e = c.expected.repeat_ask
    if (!e && !a) s.repeat.tn = 1
    else if (!e && a) s.repeat.fp = 1
    else if (e && !a) s.repeat.fn = 1
    else if (e && a) {
      // Repeat asks are paraphrased from context, so any keyword in common is enough.
      if (overlap(e.item, a.item) > 0) s.repeat.tp = 1
      else {
        s.repeat.fp = 1
        s.repeat.fn = 1
      }
    }
    if (s.repeat.fp || s.repeat.fn) s.notes.push(`repeat_ask: expected ${e ? `"${e.item}"` : 'null'}, got ${a ? `"${a.item}"` : 'null'}`)
    s.pass = !s.repeat.fp && !s.repeat.fn
  } else {
    const got = new Set((actual as DeliveryCheck).delivered_ids)
    const want = new Set(c.expected.delivered_ids)
    for (const id of got) if (want.has(id)) s.delivered.tp++
    else s.delivered.fp++
    for (const id of want) if (!got.has(id)) s.delivered.fn++
    if (s.delivered.fp || s.delivered.fn) s.notes.push(`delivered: expected [${[...want].join(', ')}], got [${[...got].join(', ')}]`)
    s.pass = !s.delivered.fp && !s.delivered.fn
  }
  return s
}
