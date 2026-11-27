/*
 * Client style guide (AI reply drafts pilot). READ ONLY: reads one client's WhatsApp history and makes one model call.
 * Writes local files under style-guides/ (git-ignored: they hold client chat content):
 *   <slug>.md               the style guide, for the accountant to review and correct
 *   <slug>.test-pairs.json  the latest question and reply pairs, held back from the guide for scripts/draft-test.ts
 *   <slug>.seed.sql         with --sql: an upsert of the reviewed <slug>.md into settings, for a human to run in
 *                           Supabase so the live Suggested reply starts from the reviewed guide (no model call)
 *
 * Run by a human, from the repo root:
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/style-guide.ts --group <whatsapp_group_id>
 *   ... --dry          counts and sizes only, no model call
 *   ... --holdout 20   pairs held back for the test (default 20)
 *   ... --sql          write <slug>.seed.sql from the existing <slug>.md (after the accountant's review)
 *
 * Safety: credential values (OTP, password) are masked by toMessageItem / sanitiseBody before anything is written or
 * sent; phone, account and long card numbers are replaced with [number]. Nothing is written to the database.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import { fetchAll } from '@/lib/data/paginate'
import { MESSAGE_COLS, toMessageItem } from '@/lib/data/messages'
import { clean, line, slugOf } from '@/lib/reply/chat-text'
import {
  buildGuidePrompt,
  DEFAULT_GUIDE_MODEL,
  GUIDE_MAX_OUTPUT_TOKENS,
  guideLooksComplete,
  guideSettingKey,
  qaPairs,
  serializeGuide,
  STYLE_GUIDE_SYSTEM,
  tidyGuide,
} from '@/lib/reply/style-guide'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getTeamNumbers } from '@/lib/team'

const OUT_DIR = 'style-guides'
/** Header lines this script writes above the guide in <slug>.md; --sql drops them. */
const HEADER_LINES = 5

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** SQL string literal (single quotes doubled). */
function sqlText(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

async function writeSeedSql(clientId: string, clientName: string, slug: string): Promise<void> {
  const md = await readFile(`${OUT_DIR}/${slug}.md`, 'utf8')
  const lines = md.split(/\r?\n/)
  const built = /from (\d+) messages/.exec(lines[2] ?? '')
  const guide = lines.slice(HEADER_LINES).join('\n').trim()
  if (!guideLooksComplete(guide)) throw new Error(`${slug}.md has no section 7: it may be cut off. Rebuild it first.`)
  const value = serializeGuide({
    guide,
    version: 1,
    model: /by (\S+)\./.exec(lines[2] ?? '')?.[1] ?? DEFAULT_GUIDE_MODEL,
    builtAt: new Date().toISOString(),
    messages: built ? Number(built[1]) : 0,
    corrections: 0,
  })
  const sql = [
    `-- Reviewed style guide for ${clientName.replace(/\n/g, ' ')}: run in the Supabase SQL editor after reply-suggestions.sql.`,
    '-- Holds client chat content: do not commit or share. Rollback: delete from public.settings where key = the key below;',
    `insert into public.settings (key, value, note) values (${sqlText(guideSettingKey(clientId))}, ${sqlText(value)}, ${sqlText(
      `Suggested reply style guide: ${clientName}`,
    )})`,
    'on conflict (key) do update set value = excluded.value, note = excluded.note;',
    '',
  ].join('\n')
  await writeFile(`${OUT_DIR}/${slug}.seed.sql`, sql, 'utf8')
  console.log(`Wrote ${OUT_DIR}/${slug}.seed.sql`)
}

async function main(): Promise<void> {
  const group = arg('group')
  if (!group) throw new Error('Pass --group <whatsapp_group_id>')
  const holdout = Number(arg('holdout') ?? 20)
  const dry = process.argv.includes('--dry')

  const db = createAdminSupabase()
  const { data: client, error } = await db
    .from('clients')
    .select('client_id, client_name')
    .eq('whatsapp_group_id', group)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!client) throw new Error(`No client with whatsapp_group_id ${group}`)
  const slug = slugOf(client.client_name)
  if (process.argv.includes('--sql')) return writeSeedSql(client.client_id, client.client_name, slug)

  const team = await getTeamNumbers()
  const rows = await fetchAll('messages', (from, to) =>
    db
      .from('client_messages')
      .select(MESSAGE_COLS)
      .eq('client_id', client.client_id)
      .order('message_timestamp', { ascending: true })
      .order('message_id', { ascending: true })
      .range(from, to),
  )
  const messages = rows.map((r) => toMessageItem(r, team)).filter((m) => (m.body ?? '').trim())
  const all = qaPairs(messages)
  const held = all.slice(-holdout)
  // Everything from the first held-back question on is kept out of the guide, so the test cannot see the answers.
  const cutAt = held.length ? Date.parse(held[0].question[0].at) : Infinity
  const forGuide = messages.filter((m) => Date.parse(m.at) < cutAt)
  const transcript = forGuide.map(line).join('\n')

  const summary = {
    client: client.client_name,
    messages: messages.length,
    teamMessages: messages.filter((m) => m.direction === 'outgoing').length,
    pairs: all.length,
    heldBack: held.length,
    guideMessages: forGuide.length,
    guideFrom: forGuide[0]?.at ?? null,
    guideTo: forGuide[forGuide.length - 1]?.at ?? null,
    transcriptChars: transcript.length,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (dry) return

  await mkdir(OUT_DIR, { recursive: true })
  const testPairs = held.map((p) => ({
    askedAt: p.question[0].at,
    question: p.question.map(clean).join('\n'),
    actualReply: p.reply.map(clean).join('\n'),
    questionIds: p.question.map((m) => m.id),
  }))
  await writeFile(`${OUT_DIR}/${slug}.test-pairs.json`, JSON.stringify(testPairs, null, 2), 'utf8')

  const apiKey = process.env.OPENROUTER_API_KEY?.trim()
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set.')
  const modelId = process.env.STYLE_GUIDE_MODEL?.trim() || DEFAULT_GUIDE_MODEL
  const { text, usage } = await generateText({
    model: createOpenRouter({ apiKey }).chat(modelId),
    system: STYLE_GUIDE_SYSTEM,
    prompt: buildGuidePrompt(client.client_name, transcript),
    temperature: 0.2,
    maxOutputTokens: GUIDE_MAX_OUTPUT_TOKENS,
  })
  const body = tidyGuide(text)
  if (!guideLooksComplete(body))
    console.warn('WARNING: the guide has no section 7: it may be cut off. Read the end before using it.')
  const header = [
    `# Style guide: ${client.client_name}`,
    '',
    `Built from ${summary.guideMessages} messages (${summary.guideFrom?.slice(0, 10)} to ${summary.guideTo?.slice(0, 10)}) by ${modelId}.`,
    `The latest ${summary.heldBack} question and reply pairs were held back for the test (${slug}.test-pairs.json).`,
    'Draft for review: correct anything that is wrong before it is used.',
  ].join('\n')
  await writeFile(`${OUT_DIR}/${slug}.md`, `${header}\n\n${body}\n`, 'utf8')
  console.log(
    `Wrote ${OUT_DIR}/${slug}.md and ${OUT_DIR}/${slug}.test-pairs.json (tokens in ${usage.inputTokens}, out ${usage.outputTokens})`,
  )
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
