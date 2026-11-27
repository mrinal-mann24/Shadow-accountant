import 'server-only'
// style-guides job (daily cron): rebuilds the style guide of each pilot client whose guide is missing or older than
// REBUILD_AFTER_DAYS, from the client's latest messages plus the corrections accountants made to suggested replies
// (that is how the AI learns from edits). Write runs only (jobsWriteEnabled('style-guides')); a dry run lists which
// clients are due and makes no model calls. A guide that comes back cut off is not saved: the old one stays.
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import type { JobResult } from '@/lib/jobs/guard'
import { toMessageItem } from '@/lib/data/messages'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getTeamNumbers } from '@/lib/team'
import { line } from './chat-text'
import { supabaseGuideStore, type GuideStore } from './guide-store'
import {
  buildGuidePrompt,
  DEFAULT_GUIDE_MODEL,
  GUIDE_MAX_OUTPUT_TOKENS,
  guideLooksComplete,
  STYLE_GUIDE_SYSTEM,
  tidyGuide,
  type StoredGuide,
} from './style-guide'

export const JOB = 'style-guides'
/** A guide this old is rebuilt (with the edits made since). */
export const REBUILD_AFTER_DAYS = 7
/** Latest messages a guide is built from (the longest pilot chat, about 1,700 messages, fits). */
export const GUIDE_MESSAGES = 1500
/** Latest accountant corrections a guide is built with. */
export const GUIDE_CORRECTIONS = 30
/** Stop starting new clients after this much of the route's 300 s: one guide takes up to about 2 minutes. */
export const DEFAULT_BUDGET_MS = 150_000

export type GuideJobDeps = {
  store?: GuideStore
  /** Writes the guide; returns the model's text. */
  generate?: (system: string, prompt: string) => Promise<string>
  modelId?: string
  teamNumbers?: Set<string>
  /** Clock for the time budget (tests). */
  clock?: () => number
}

export type GuideOutcome = {
  client: string
  clientId: string
  status: 'would_rebuild' | 'rebuilt' | 'up_to_date' | 'skipped_cut_off' | 'no_messages' | 'deferred' | 'failed'
  version?: number
  messages?: number
  corrections?: number
}

/** True when the guide is missing or older than REBUILD_AFTER_DAYS. */
export function isDue(guide: StoredGuide | null, nowMs: number): boolean {
  if (!guide) return true
  const built = Date.parse(guide.builtAt)
  return !Number.isFinite(built) || nowMs - built >= REBUILD_AFTER_DAYS * 86_400_000
}

const defaultGenerate =
  (modelId: string) =>
  async (system: string, prompt: string): Promise<string> => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim()
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set.')
    const { text } = await generateText({
      model: createOpenRouter({ apiKey }).chat(modelId),
      system,
      prompt,
      temperature: 0.2,
      maxOutputTokens: GUIDE_MAX_OUTPUT_TOKENS,
      maxRetries: 1,
    })
    return text
  }

export async function runStyleGuideJob(
  o: { write: boolean; now: Date; clientIds?: string[]; force?: boolean; budgetMs?: number },
  deps: GuideJobDeps = {},
): Promise<JobResult> {
  const result: JobResult = { job: JOB, dryRun: !o.write, processed: 0, written: 0, errors: [] }
  const store = deps.store ?? supabaseGuideStore(createAdminSupabase())
  const modelId = deps.modelId ?? (process.env.STYLE_GUIDE_MODEL?.trim() || DEFAULT_GUIDE_MODEL)
  const generate = deps.generate ?? defaultGenerate(modelId)
  const clock = deps.clock ?? (() => Date.now())
  const startedAt = clock()
  const budgetMs = o.budgetMs ?? DEFAULT_BUDGET_MS
  const nowMs = o.now.getTime()

  const pilot = await store.pilotClients()
  const ids = o.clientIds?.length ? pilot.filter((id) => o.clientIds!.includes(id)) : pilot
  if (!ids.length) {
    result.details = { clients: 0, note: 'No pilot clients (settings reply_pilot_clients is empty or not set).', outcomes: [] }
    return result
  }
  const names = await store.clientNames(ids)
  const guides = new Map(await Promise.all(ids.map(async (id) => [id, await store.guide(id)] as const)))
  // Oldest (or missing) guide first, so a run that stops early catches up the most stale one next time.
  const order = [...ids].sort((a, b) => (Date.parse(guides.get(a)?.builtAt ?? '') || 0) - (Date.parse(guides.get(b)?.builtAt ?? '') || 0))
  const team = deps.teamNumbers ?? (await getTeamNumbers())

  const outcomes: GuideOutcome[] = []
  for (const id of order) {
    const client = names.get(id) ?? id
    const old = guides.get(id) ?? null
    const outcome: GuideOutcome = { client, clientId: id, status: 'up_to_date', version: old?.version }
    outcomes.push(outcome)
    if (!o.force && !isDue(old, nowMs)) continue
    if (o.write && clock() - startedAt >= budgetMs) {
      outcome.status = 'deferred'
      continue
    }
    result.processed++
    try {
      const rows = await store.messages(id, GUIDE_MESSAGES)
      const messages = rows.map((r) => toMessageItem(r, team)).filter((m) => (m.body ?? '').trim())
      const corrections = await store.corrections(id, GUIDE_CORRECTIONS)
      outcome.messages = messages.length
      outcome.corrections = corrections.length
      if (!messages.length) {
        outcome.status = 'no_messages'
        continue
      }
      if (!o.write) {
        outcome.status = 'would_rebuild'
        continue
      }
      const text = await generate(STYLE_GUIDE_SYSTEM, buildGuidePrompt(client, messages.map(line).join('\n'), corrections))
      const guide = tidyGuide(text)
      if (!guideLooksComplete(guide)) {
        outcome.status = 'skipped_cut_off'
        result.errors.push(`${client}: the new guide came back cut off (no section 7); the old guide was kept`)
        continue
      }
      const version = (old?.version ?? 0) + 1
      await store.saveGuide(id, client, {
        guide,
        version,
        model: modelId,
        builtAt: o.now.toISOString(),
        messages: messages.length,
        corrections: corrections.length,
      })
      outcome.status = 'rebuilt'
      outcome.version = version
      result.written++
    } catch (e) {
      outcome.status = 'failed'
      result.errors.push(`${client}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  result.details = { clients: ids.length, model: modelId, outcomes }
  return result
}
