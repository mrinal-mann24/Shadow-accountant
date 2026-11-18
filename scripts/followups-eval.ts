/*
 * Follow-ups extractor evaluation on the labelled set in lib/followups/eval-cases.ts.
 * NEVER touches the database: no Supabase client is created. Each case is one live model call (OpenRouter).
 *
 * Run by a human, from the repo root (needs OPENROUTER_API_KEY and OPENROUTER_MODEL_A, or _B with --slot B):
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/followups-eval.ts
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/followups-eval.ts --only team --slot B
 *
 * --only team|client|delivery   run one kind only
 * --slot A|B                    model slot (default A, the one the job uses)
 * --prefilter                   also skip cases the prefilter drops, as the job does (they count as empty output)
 * --conditions=react-server lets the server-only modules load outside Next.
 *
 * Prints per-case PASS / FAIL with reasons, then precision and recall for promises, document requests,
 * repeat asks and deliveries, and due date accuracy on matched promises.
 */
import { getModel, getModelId, type ModelSlot } from '@/lib/ai/openrouter'
import { createFollowUpAI } from '@/lib/followups/extract'
import { EVAL_CASES, EVAL_TODAY, caseContext, caseMessage, scoreCase, type CaseScore, type Counts, type EvalCase } from '@/lib/followups/eval-cases'
import { mightBeRepeatAsk, mightBeTeamFollowUp } from '@/lib/followups/prefilter'
import type { ClientExtraction, DeliveryCheck, FollowUpAI, TeamExtraction } from '@/lib/followups/types'

function arg(name: string): string | null {
  const args = process.argv.slice(2)
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? null) : null
}

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : 'n/a'
}

function prf(label: string, c: Counts): string {
  return `${label.padEnd(18)} precision ${pct(c.tp, c.tp + c.fp).padEnd(18)} recall ${pct(c.tp, c.tp + c.fn)}`
}

function add(a: Counts, b: Counts): void {
  a.tp += b.tp
  a.fp += b.fp
  a.fn += b.fn
}

async function run(ai: FollowUpAI, c: EvalCase, usePrefilter: boolean): Promise<TeamExtraction | ClientExtraction | DeliveryCheck> {
  if (c.kind === 'team') {
    if (usePrefilter && !mightBeTeamFollowUp(c.input)) return { promises: [], document_requests: [] }
    return ai.team(caseMessage(c), caseContext(c), c.today ?? EVAL_TODAY)
  }
  if (c.kind === 'client') {
    if (usePrefilter && !mightBeRepeatAsk(c.input)) return { repeat_ask: null }
    return ai.client(caseMessage(c), caseContext(c), c.open ?? [])
  }
  return ai.delivered({ kind: c.evidence, text: c.input, at: '2026-11-18T06:30:00Z' }, c.open)
}

async function main(): Promise<void> {
  const only = arg('--only')
  const slot: ModelSlot = arg('--slot') === 'B' ? 'B' : 'A'
  const usePrefilter = process.argv.includes('--prefilter')
  if (only && !['team', 'client', 'delivery'].includes(only)) throw new Error('--only must be team, client or delivery')

  const ai = createFollowUpAI({ model: getModel(slot) })
  const cases = EVAL_CASES.filter((c) => !only || c.kind === only)
  console.log(`Follow-ups eval: ${cases.length} cases, model ${getModelId(slot)} (slot ${slot})${usePrefilter ? ', with prefilter' : ''}\n`)

  const totals = { promises: { tp: 0, fp: 0, fn: 0 }, documents: { tp: 0, fp: 0, fn: 0 }, repeat: { tp: 0, fp: 0, fn: 0 }, delivered: { tp: 0, fp: 0, fn: 0 } }
  let tn = 0
  let passed = 0
  let failed = 0
  let errors = 0
  const due = { checked: 0, right: 0 }
  const started = Date.now()

  for (const c of cases) {
    let score: CaseScore
    try {
      score = scoreCase(c, await run(ai, c, usePrefilter))
    } catch (e) {
      errors++
      console.log(`ERROR ${c.id}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    add(totals.promises, score.promises)
    add(totals.documents, score.documents)
    add(totals.repeat, score.repeat)
    add(totals.delivered, score.delivered)
    tn += score.repeat.tn
    due.checked += score.dueDates.checked
    due.right += score.dueDates.right
    if (score.pass) passed++
    else failed++
    console.log(`${score.pass ? 'PASS ' : 'FAIL '} ${c.id}${score.notes.length ? `\n        ${score.notes.join('\n        ')}` : ''}`)
  }

  console.log(`\n${passed} passed, ${failed} failed, ${errors} errors in ${((Date.now() - started) / 1000).toFixed(0)} s`)
  console.log(prf('Promises', totals.promises))
  console.log(prf('Document requests', totals.documents))
  console.log(`${prf('Repeat asks', totals.repeat)}   (correct nulls: ${tn})`)
  console.log(prf('Deliveries', totals.delivered))
  console.log(`Due dates on matched promises: ${pct(due.right, due.checked)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
