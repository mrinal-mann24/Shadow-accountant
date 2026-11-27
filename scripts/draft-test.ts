/*
 * Draft test (AI reply drafts pilot, step 3). READ ONLY: for each question held back by style-guide.ts, model A (the
 * Draft reply model) writes a reply from the client's style guide and the 15 messages before the question; model B
 * then rates it against the reply our team actually sent. Writes style-guides/<slug>.draft-test.<prompt>.csv (git-ignored),
 * a score sheet for the accountant with a blank "Accountant score" column. Nothing is written to the database.
 *
 * Run by a human, from the repo root, after style-guide.ts:
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/draft-test.ts --group <whatsapp_group_id>
 *   ... --limit 3   only the first 3 questions (a quick look)
 *   ... --prompt v1 the drafting rules to test: v1, v2 or v3 (default v3)
 */
import { readFile, writeFile } from 'node:fs/promises'
import { generateObject, generateText } from 'ai'
import { z } from 'zod'
import { maskCredentials } from '@/lib/ai/redact'
import { getModel, getModelId } from '@/lib/ai/openrouter'
import { MESSAGE_COLS, toMessageItem } from '@/lib/data/messages'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getTeamNumbers } from '@/lib/team'
import { istTime, line, maskNumbers, slugOf } from '@/lib/reply/chat-text'
import { buildSuggestPrompt, DRAFT_PROMPTS, SUGGEST_MAX_OUTPUT_TOKENS, type PromptVersion } from '@/lib/reply/suggest-prompt'

const OUT_DIR = 'style-guides'
const RECENT = 15
const CONCURRENCY = 4

type TestPair = {
  askedAt: string
  question: string
  actualReply: string
  questionIds: string[]
}
const RATINGS = ['send_as_is', 'small_edit', 'wrong'] as const
const RATING_LABEL: Record<(typeof RATINGS)[number], string> = {
  send_as_is: 'Send as is',
  small_edit: 'Small edit',
  wrong: 'Wrong',
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// The rater sees the same recent messages as the drafter (27 Nov 2026): without them it called facts taken from the
// chat "invented" (KRRD: a cheque amount and party named three messages earlier).
const JUDGE_SYSTEM = `You check AI-drafted WhatsApp replies for an Indian virtual accounting team.
You get the recent messages the drafter saw, the client's question, the reply our team actually sent, and the AI draft.
A fact the draft takes from the recent messages is not invented. Rate the draft:
- "send_as_is": our accountant could send it unchanged. It answers or correctly holds the question, fits the tone, and says nothing wrong.
- "small_edit": right intent and tone, but needs a small change (a word, a detail, length).
- "wrong": wrong intent, wrong facts, invented details, wrong tone, or it would confuse the client.
The AI could not know facts that only our team knew (for example that a file was already prepared). A correct holding
reply ("checking, will share shortly") where our team delivered the item is "small_edit", not "wrong".
A draft may contain placeholders in square brackets for the accountant to fill (for example [attach: invoice PDF]).
A placeholder in the right place is fine; judge the rest of the draft.
Give a one-sentence reason in plain English.`

const judgeSchema = z.object({
  rating: z.enum(RATINGS),
  reason: z.string().describe('One sentence'),
})

function csvCell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

async function main(): Promise<void> {
  const group = arg('group')
  if (!group) throw new Error('Pass --group <whatsapp_group_id>')
  const limit = arg('limit') ? Number(arg('limit')) : undefined
  const version = (arg('prompt') ?? 'v3') as PromptVersion
  if (!(version in DRAFT_PROMPTS)) throw new Error(`--prompt must be one of ${Object.keys(DRAFT_PROMPTS).join(', ')}`)
  const draftSystem = DRAFT_PROMPTS[version]

  const db = createAdminSupabase()
  const { data: client, error } = await db
    .from('clients')
    .select('client_id, client_name')
    .eq('whatsapp_group_id', group)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!client) throw new Error(`No client with whatsapp_group_id ${group}`)
  const slug = slugOf(client.client_name)
  const guide = await readFile(`${OUT_DIR}/${slug}.md`, 'utf8')
  const all: TestPair[] = JSON.parse(await readFile(`${OUT_DIR}/${slug}.test-pairs.json`, 'utf8'))
  const pairs = limit ? all.slice(0, limit) : all
  const team = await getTeamNumbers()
  const draftModel = getModel('A')
  const judgeModel = getModel('B')

  const rows = await pool(pairs, CONCURRENCY, async (p, i) => {
    const { data, error: e } = await db
      .from('client_messages')
      .select(MESSAGE_COLS)
      .eq('client_id', client.client_id)
      .lt('message_timestamp', p.askedAt)
      .order('message_timestamp', { ascending: false })
      .limit(RECENT)
    if (e) throw new Error(e.message)
    const recent =
      (data ?? [])
        .map((r) => toMessageItem(r, team))
        .reverse()
        .map(line)
        .join('\n') || '(none)'

    const prompt = buildSuggestPrompt({
      clientName: client.client_name,
      guide,
      recentLines: recent === '(none)' ? [] : recent.split('\n'),
      question: p.question,
      askedAtIst: istTime(p.askedAt),
    })
    // 600 output tokens left 4 of 20 KRRD drafts empty (the model's reasoning used them up): allow more, retry once.
    let text = ''
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      const res = await generateText({
        model: draftModel,
        system: draftSystem,
        prompt,
        temperature: 0.2,
        maxOutputTokens: SUGGEST_MAX_OUTPUT_TOKENS,
      })
      text = res.text.trim()
    }
    // A credential-looking value is hidden, not the whole draft: "OTP sir" made the old check block a good draft.
    const draft = text ? maskCredentials(maskNumbers(text)) : '[no draft: the model returned nothing twice]'

    const judged = await generateObject({
      model: judgeModel,
      schema: judgeSchema,
      schemaName: 'draft_rating',
      system: JUDGE_SYSTEM,
      prompt: `RECENT MESSAGES (oldest first):\n<history>\n${recent}\n</history>\n\nCLIENT'S QUESTION:\n<q>${p.question}</q>\n\nREPLY OUR TEAM SENT:\n<actual>${p.actualReply}</actual>\n\nAI DRAFT:\n<draft>${draft}</draft>`,
      temperature: 0,
    })
    process.stdout.write(`${i + 1}/${pairs.length} ${judged.object.rating}\n`)
    return {
      p,
      draft,
      rating: judged.object.rating,
      reason: judged.object.reason,
    }
  })

  const header = [
    'No',
    'Asked at (IST)',
    'Client question',
    'Our team’s actual reply',
    'AI draft',
    'First AI rating',
    'Why',
    'Accountant score (Send as is / Small edit / Wrong)',
    'Accountant notes',
  ]
  const lines = [header.map(csvCell).join(',')]
  rows.forEach((r, i) =>
    lines.push(
      [String(i + 1), istTime(r.p.askedAt), r.p.question, r.p.actualReply, r.draft, RATING_LABEL[r.rating], r.reason, '', '']
        .map(csvCell)
        .join(','),
    ),
  )
  // BOM so Excel opens it as UTF-8 (Hindi text, rupee sign).
  await writeFile(`${OUT_DIR}/${slug}.draft-test.${version}.csv`, `﻿${lines.join('\r\n')}\r\n`, 'utf8')

  const count = (k: (typeof RATINGS)[number]) => rows.filter((r) => r.rating === k).length
  console.log(
    JSON.stringify(
      {
        client: client.client_name,
        draftModel: getModelId('A'),
        judgeModel: getModelId('B'),
        questions: rows.length,
        sendAsIs: count('send_as_is'),
        smallEdit: count('small_edit'),
        wrong: count('wrong'),
        usable: `${count('send_as_is') + count('small_edit')}/${rows.length}`,
        prompt: version,
        sheet: `${OUT_DIR}/${slug}.draft-test.${version}.csv`,
      },
      null,
      2,
    ),
  )
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
