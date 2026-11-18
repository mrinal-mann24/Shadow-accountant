import { describe, expect, it } from 'vitest'
import { EVAL_CASES, isPositive } from './eval-cases'
import { isAckOnly, isHoldingReply, mightBeRepeatAsk, mightBeTeamFollowUp } from './prefilter'

describe('isAckOnly', () => {
  it.each(['', '   ', 'Ok', 'ok sir', 'Thanks', 'Thank you sir 🙏', 'Noted', 'Good morning', 'Received sir, thanks', '👍', '🙏🙏', 'Ji sir', "Ok ma'am"])(
    '%j is an acknowledgement only',
    (s) => expect(isAckOnly(s)).toBe(true),
  )
  it.each(['Ok, will share tomorrow', 'Thanks, please send the ledger', 'noted, kal tak bhej dunga'])('%j is not', (s) =>
    expect(isAckOnly(s)).toBe(false),
  )
})

describe('mightBeTeamFollowUp', () => {
  it.each([
    'We will give this by tommo Sir',
    'Hi sir Please share following documents for the month of Oct: Personal Bank statements, CC statements',
    'Will share you the dashboard in few days',
    'kal tak bhej dunga',
    'Aaj EOD tak ho jayega',
    "I'll send it by 25/11",
    'Due on 25th',
    'plz upload form 16',
    'Will revert by Monday',
  ])('passes %j', (s) => expect(mightBeTeamFollowUp(s)).toBe(true))

  it.each(['', 'Ok sir', 'Thanks', 'Noted', 'Good morning sir', '👍', 'Received sir, thanks', null, undefined])('drops %j', (s) =>
    expect(mightBeTeamFollowUp(s)).toBe(false),
  )
})

describe('mightBeRepeatAsk', () => {
  it.each([
    'When will this happen?',
    'Any update on the GST filing?',
    'Still waiting for the P&L',
    'MIS kab tak milega',
    'reminder pls',
    'Is it done?',
    'status?',
    'Haven’t received the ledger yet',
    'abhi tak nahi aaya',
    'Done? 🙏',
  ])('passes %j', (s) => expect(mightBeRepeatAsk(s)).toBe(true))

  it.each(['', 'Ok', 'Thanks, received', 'Good morning 🙏', 'Sharing the bank statements', 'Noted sir', null])('drops %j', (s) =>
    expect(mightBeRepeatAsk(s)).toBe(false),
  )

  it('does not treat a long message ending in "?" as a short ask', () => {
    const long = `${'we are sharing the documents for the quarter and the details are below '.repeat(3)}ok?`
    expect(mightBeRepeatAsk(long)).toBe(false)
  })
})

describe('isHoldingReply', () => {
  it.each([
    'Will check and revert sir',
    'Checking',
    'Let me check',
    'Will revert by Monday on the GST refund status',
    'Give me some time sir',
    'Looking into it',
    'Sir dekhte hain',
    'Will get back to you',
  ])('%j is a holding reply', (s) => expect(isHoldingReply(s)).toBe(true))

  it.each(['', null, 'Ok sir', 'GSTR-3B is filed, ARN shared on mail', 'Checked, it is done', 'Checking... here is the ledger', 'Will send the MIS tomorrow'])(
    '%j is not',
    (s) => expect(isHoldingReply(s)).toBe(false),
  )
})

describe('prefilter on the eval set', () => {
  const prefiltered = EVAL_CASES.filter((c) => c.kind !== 'delivery')
  const pass = (c: (typeof prefiltered)[number]) => (c.kind === 'team' ? mightBeTeamFollowUp(c.input) : mightBeRepeatAsk(c.input))

  it('has 100% recall: every case that expects an item passes the prefilter', () => {
    const missed = prefiltered.filter((c) => isPositive(c) && !pass(c)).map((c) => c.id)
    expect(missed).toEqual([])
  })

  it('reports the negative pass rate (negatives dropped before any model call)', () => {
    const negatives = prefiltered.filter((c) => !isPositive(c))
    const dropped = negatives.filter((c) => !pass(c))
    const positives = prefiltered.length - negatives.length
    console.log(
      `prefilter: ${positives} positives (recall 100%), ${negatives.length} negatives, ` +
        `${dropped.length} dropped (${((100 * dropped.length) / negatives.length).toFixed(0)}%), ` +
        `let through: ${negatives.filter(pass).map((c) => c.id).join(', ')}`,
    )
    // Acknowledgement-only negatives must always be dropped.
    for (const c of negatives) if (isAckOnly(c.input)) expect(pass(c)).toBe(false)
    expect(dropped.length).toBeGreaterThan(0)
  })
})
