/*
 * Fixed council cases (an eval set). READ ONLY: no database reads or writes, only model calls.
 * Each case is one new message with a hand-made context; both council models vote and the combined decision is
 * checked against the expected one. Costs two model calls per case.
 *
 * Run by a human, from the repo root:
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/council-cases.ts
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/council-cases.ts --only invoice
 *
 * Cases come from real tickets the council got wrong (client details changed).
 */
import { combineVotes, validateVote } from '@/lib/council/decide'
import { buildCouncilPrompt } from '@/lib/council/prompt'
import type { CouncilContext, ContextMessage, Decision } from '@/lib/council/types'
import { askModel, withOneRetry } from '@/lib/council/vote'

type Case = { name: string; ctx: CouncilContext; expect: Decision; target?: string }

const msg = (id: string, at: string, direction: 'incoming' | 'outgoing', body: string): ContextMessage => ({
  id,
  at,
  sender: direction === 'incoming' ? 'Client' : 'Accountant',
  direction,
  body,
})

// AJ Metalware, 24 Nov 2026 (client name changed). The 11:57 request opened T1; T2 is another buyer's invoice.
const FIRST = msg(
  'm1',
  '2026-11-24T06:27:56Z',
  'incoming',
  'Vechile no   DL01LAJ2438\n\nWeight   1883.400 kgs\n\nRate  180/- per kgs\n\ns.s utensils m    item name\n\n73239390  hsn code\n  make sale invoice name of shri sai ram steels',
)
const CHASE = msg('m2', '2026-11-24T06:48:45Z', 'incoming', 'please make sale invoice')
const OTHER = msg('m3', '2026-11-24T07:16:59Z', 'incoming', 'Vechile no DL01LQ9409\nWeight 1876.700\nRate 180/- per kgs\ns.s utensils\nmake sale invoice name of jai maa jhandewali')
const REPLY = msg('m4', '2026-11-24T08:20:59Z', 'outgoing', 'Will share this in sometime')
const T1 = {
  id: 't1',
  title: 'Sale invoice for Shri Sai Ram Steels, 1883.4 kg at Rs 180/kg',
  summary: 'Client asked for a sale invoice to Shri Sai Ram Steels: vehicle DL01LAJ2438, 1883.4 kg at Rs 180/kg, SS utensils, HSN 73239390, and chased it once.',
  last_message_at: CHASE.at,
}
const T2 = {
  id: 't2',
  title: 'Sale invoice for Jai Maa Jhandewali, 1876.7 kg at Rs 180/kg',
  summary: 'Client asked for a sale invoice to Jai Maa Jhandewali: vehicle DL01LQ9409, 1876.7 kg at Rs 180/kg. Team said they will share it in some time.',
  last_message_at: REPLY.at,
}
const base = (message: ContextMessage): CouncilContext => ({
  clientName: 'Metal Traders',
  message,
  recent: [FIRST, CHASE, OTHER, REPLY],
  open: [T1, T2],
  recentlyClosed: [],
})

const CASES: Case[] = [
  {
    name: 'invoice: same vehicle and buyer, new weight, no word of a correction -> new',
    ctx: base(
      msg(
        'n1',
        '2026-11-24T10:30:09Z',
        'incoming',
        'Vechile no   DL01LAJ2438\n\nWeight   1914.800 kgs\n\nRate  180/- per kgs\n\ns.s utensils m    item name\n\n73239390  hsn code\n MAKE SALE INVOICE NAME OF SHRI SAI RAM STEELS',
      ),
    ),
    expect: 'new',
  },
  {
    name: 'invoice: a new buyer and vehicle while others are open -> new',
    ctx: base(msg('n2', '2026-11-24T10:40:00Z', 'incoming', 'Vehicle no HR55AB1234\nWeight 1650 kgs\nRate 182 per kg\nmake sale invoice name of Balaji Metals')),
    expect: 'new',
  },
  {
    name: 'invoice: the client corrects the earlier weight -> continue t1',
    ctx: base(msg('n3', '2026-11-24T10:45:00Z', 'incoming', 'Shri Sai Ram Steels invoice: weight is 1914.800 not 1883.400, please correct it')),
    expect: 'continue',
    target: 't1',
  },
  {
    name: 'invoice: a chase without new details -> continue',
    ctx: base(msg('n4', '2026-11-24T10:50:00Z', 'incoming', 'please make the shri sai ram steels sale invoice fast')),
    expect: 'continue',
    target: 't1',
  },
  {
    name: 'invoice: the team shares the invoice -> close t2',
    ctx: base(msg('n5', '2026-11-24T11:00:00Z', 'outgoing', 'Sir, sale invoice for Jai Maa Jhandewali (1876.7 kg) is attached and shared.')),
    expect: 'close',
    target: 't2',
  },
  {
    name: 'invoice: a plain "ok thanks" -> no_action',
    ctx: base(msg('n6', '2026-11-24T11:05:00Z', 'incoming', 'ok thanks')),
    expect: 'no_action',
  },
]

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const oi = args.indexOf('--only')
  const only = oi >= 0 ? (args[oi + 1] ?? '').toLowerCase() : ''
  const cases = CASES.filter((c) => !only || c.name.toLowerCase().includes(only))
  let pass = 0
  for (const c of cases) {
    const prompt = buildCouncilPrompt(c.ctx)
    const [ra, rb] = await Promise.all([withOneRetry(() => askModel('A', prompt)), withOneRetry(() => askModel('B', prompt))])
    const final = combineVotes(validateVote(ra.vote, c.ctx), validateVote(rb.vote, c.ctx))
    const ok = final.decision === c.expect && (!c.target || final.targetConversationId === c.target)
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}`)
    console.log(`     A ${ra.model}: ${ra.vote.decision} ${ra.vote.target_conversation_id ?? ''} | B ${rb.model}: ${rb.vote.decision} ${rb.vote.target_conversation_id ?? ''} | final ${final.decision} ${final.targetConversationId ?? ''}`)
    if (!ok) console.log(`     A: ${ra.vote.reasoning}\n     B: ${rb.vote.reasoning}`)
  }
  console.log(`\n${pass}/${cases.length} passed`)
  if (pass !== cases.length) process.exit(1)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
