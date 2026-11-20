/*
 * Ticket council evaluation. READ ONLY: it never writes to the database.
 * Compares the new council against the old council's council_verdicts.final_decision.
 *
 * Run by a human, from the repo root:
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/council-eval.ts --offline
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/council-eval.ts --limit 50
 *
 * --offline   no model calls. Old votes agreement, and the new tie-break rule replayed on the old votes.
 * --limit N   (default 50) most recent N verdicts. Without --offline, each one costs two model calls.
 * --message ID   only this message (client_messages.message_id); prints both votes and the final decision.
 * --conditions=react-server lets the server-only modules load outside Next.
 *
 * Known limit: ticket titles and summaries are today's values, not as they were at message time,
 * so the live replay sees slightly more than the old council did.
 */
import { createAdminSupabase } from '@/lib/supabase/admin'
import { effectiveDirection, loadTeamNumbers } from '@/lib/team'
import { combineVotes, validateVote } from '@/lib/council/decide'
import { buildCouncilPrompt } from '@/lib/council/prompt'
import { DECISIONS, type CouncilContext, type Decision, type Vote } from '@/lib/council/types'
import { askModel, withOneRetry } from '@/lib/council/vote'

type Matrix = Record<string, Record<string, number>>

function emptyMatrix(): Matrix {
  const m: Matrix = {}
  for (const a of [...DECISIONS, 'other']) {
    m[a] = {}
    for (const b of [...DECISIONS, 'other']) m[a][b] = 0
  }
  return m
}

function bucket(d: string | null | undefined): string {
  return d && (DECISIONS as readonly string[]).includes(d) ? d : 'other'
}

function printMatrix(title: string, rowsLabel: string, m: Matrix): void {
  const cols = [...DECISIONS, 'other']
  console.log(`\n${title} (rows: ${rowsLabel})`)
  console.log(['', ...cols].map((c) => c.padStart(10)).join(''))
  for (const r of cols) console.log([r, ...cols.map((c) => String(m[r][c]))].map((c) => c.padStart(10)).join(''))
}

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : 'n/a'
}

/** Rebuilds a Vote from stored old columns (only decision and target matter for combineVotes). */
function oldVote(decision: string, target: string | null): Vote {
  return {
    decision: (bucket(decision) === 'other' ? 'no_action' : decision) as Decision,
    target_conversation_id: target,
    title: '',
    summary: '',
    tag: 'neutral',
    fault: 'neither',
    client_tone: 'neutral',
    va_tone: 'neutral',
    reasoning: '',
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const offline = args.includes('--offline')
  const li = args.indexOf('--limit')
  const limit = li >= 0 ? Math.max(1, Number.parseInt(args[li + 1] ?? '50', 10) || 50) : 50

  const mi = args.indexOf('--message')
  const onlyMessage = mi >= 0 ? (args[mi + 1] ?? null) : null

  const db = createAdminSupabase()
  let query = db
    .from('council_verdicts')
    .select('message_id, claude_decision, claude_target_conv_id, gpt_decision, gpt_target_conv_id, final_decision, final_conv_id, agreed, created_at')
  if (onlyMessage) query = query.eq('message_id', onlyMessage)
  const { data: verdicts, error } = await query.order('created_at', { ascending: false }).limit(limit)
  if (error) throw new Error(error.message)
  const rows = verdicts ?? []
  console.log(`Loaded ${rows.length} verdicts (most recent ${limit}).`)

  // Part 1: old votes, no model calls.
  const oldAB = emptyMatrix()
  const replay = emptyMatrix()
  let oldAgree = 0
  let replayAgree = 0
  for (const v of rows) {
    oldAB[bucket(v.claude_decision)][bucket(v.gpt_decision)]++
    if (v.claude_decision === v.gpt_decision) oldAgree++
    const r = combineVotes(oldVote(v.claude_decision, v.claude_target_conv_id), oldVote(v.gpt_decision, v.gpt_target_conv_id))
    replay[bucket(v.final_decision)][r.decision]++
    if (r.decision === v.final_decision) replayAgree++
  }
  console.log(`\nOld council: Claude and GPT agreed on ${pct(oldAgree, rows.length)}`)
  printMatrix('Old Claude vs old GPT', 'Claude, cols: GPT', oldAB)
  console.log(`\nNew tie-break rule on old votes matches old final_decision: ${pct(replayAgree, rows.length)}`)
  printMatrix('Old final vs new rule on old votes', 'old final, cols: new rule', replay)

  if (offline) return

  // Part 2: new models on the same messages, historical context, no writes.
  const team = await loadTeamNumbers(db)
  const live = emptyMatrix()
  let liveAgree = 0
  let targetChecked = 0
  let targetAgree = 0
  let failed = 0
  for (const v of rows) {
    try {
      const ctx = await historicalContext(db, v.message_id, team)
      if (!ctx) {
        failed++
        continue
      }
      const prompt = buildCouncilPrompt(ctx)
      const [ra, rb] = await Promise.all([withOneRetry(() => askModel('A', prompt)), withOneRetry(() => askModel('B', prompt))])
      const final = combineVotes(validateVote(ra.vote, ctx), validateVote(rb.vote, ctx))
      if (onlyMessage) {
        console.log(`
A ${ra.model}: ${ra.vote.decision} ${ra.vote.target_conversation_id ?? ''}
   ${ra.vote.reasoning}`)
        console.log(`B ${rb.model}: ${rb.vote.decision} ${rb.vote.target_conversation_id ?? ''}
   ${rb.vote.reasoning}`)
        console.log(`Final: ${final.decision} ${final.targetConversationId ?? ''} (${final.rule})
Summary (A): ${ra.vote.summary}`)
      }
      live[bucket(v.final_decision)][final.decision]++
      if (final.decision === v.final_decision) {
        liveAgree++
        if (final.decision === 'continue' || final.decision === 'close' || final.decision === 'reopen') {
          targetChecked++
          if (final.targetConversationId === v.final_conv_id) targetAgree++
        }
      }
      process.stdout.write('.')
    } catch (e) {
      failed++
      console.error(`\n${v.message_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const scored = rows.length - failed
  console.log(`\n\nNew council vs old final_decision: ${pct(liveAgree, scored)} (${failed} failed or skipped)`)
  console.log(`Same ticket when both chose continue / close / reopen: ${pct(targetAgree, targetChecked)}`)
  printMatrix('Old final vs new council', 'old final, cols: new council', live)
}

async function historicalContext(
  db: ReturnType<typeof createAdminSupabase>,
  messageId: string,
  team: Set<string>,
): Promise<CouncilContext | null> {
  const { data: m, error } = await db
    .from('client_messages')
    .select('message_id, client_id, body, direction, sender_phone, sender_name, message_timestamp, whatsapp_group_id')
    .eq('message_id', messageId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!m || !m.client_id) return null
  const at = m.message_timestamp

  let rq = db
    .from('client_messages')
    .select('message_id, body, direction, sender_phone, sender_name, message_timestamp')
    .lte('message_timestamp', at)
    .neq('message_id', m.message_id)
  rq = m.whatsapp_group_id ? rq.eq('whatsapp_group_id', m.whatsapp_group_id) : rq.eq('client_id', m.client_id)
  const [client, recent, convs] = await Promise.all([
    db.from('clients').select('client_name').eq('client_id', m.client_id).maybeSingle(),
    rq.order('message_timestamp', { ascending: false }).limit(15),
    db
      .from('conversations')
      .select('id, title, summary, last_message_at, opened_at, closed_at')
      .eq('client_id', m.client_id)
      .lt('opened_at', at),
  ])
  for (const r of [client, recent, convs]) if (r.error) throw new Error(r.error.message)

  const t = new Date(at).getTime()
  const all = convs.data ?? []
  const toCtx = (x: { message_id: string; body: string; direction: string | null; sender_phone: string | null; sender_name: string | null; message_timestamp: string }) => ({
    id: x.message_id,
    at: x.message_timestamp,
    sender: x.sender_name,
    direction: effectiveDirection(x, team),
    body: x.body,
  })
  return {
    clientName: client.data?.client_name ?? 'Unknown',
    message: toCtx(m),
    recent: (recent.data ?? []).reverse().map(toCtx),
    open: all.filter((c) => !c.closed_at || new Date(c.closed_at).getTime() > t),
    recentlyClosed: all.filter((c) => {
      const closed = c.closed_at ? new Date(c.closed_at).getTime() : NaN
      return closed <= t && closed >= t - 7 * 86_400_000
    }),
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
