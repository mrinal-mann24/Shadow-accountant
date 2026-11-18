import 'server-only'
// Follow-up extractor: one structured model call per message (or per delivery check), single model, temperature 0.
// Inputs:  a ScanMessage (+ context, + open items) or a delivery evidence; outputs the shapes in types.ts.
// Never trusts the model blindly: output is re-validated with zod, items are cleaned, capped and deduped, ids are
// filtered to the ids we gave, and dates that are not YYYY-MM-DD (or are before the message date) become null.
// Text is masked with maskCredentials before it is put in a prompt and again on the way out.
// Failure: a call that throws or returns an invalid object is retried once, then the error is thrown to the job.
import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import { getModel } from '@/lib/ai/openrouter'
import { maskCredentials } from '@/lib/ai/redact'
import { withOneRetry } from '@/lib/council/vote'
import { buildClientPrompt, buildDeliveryPrompt, buildTeamPrompt, CLIENT_SYSTEM_PROMPT, DELIVERY_SYSTEM_PROMPT, TEAM_SYSTEM_PROMPT } from './prompt'
import type { ClientExtraction, DeliveryCheck, FollowUpAI, OpenItem, ScanMessage, TeamExtraction } from './types'

export const FOLLOW_UP_TIMEOUT_MS = 45_000
export const MAX_ITEM_CHARS = 200
export const MAX_ITEMS = 10

// Schemas sent to the model. Kept loose (no lengths or patterns, some providers reject them); limits are enforced
// in code below.
export const teamSchema = z.object({
  promises: z
    .array(
      z.object({
        item: z.string().describe('What our team promised, a short key phrase starting with a verb'),
        due_date: z.string().nullable().describe('YYYY-MM-DD resolved against TODAY, or null when no clear date'),
        due_time: z.string().nullable().describe('HH:MM 24 hour when a clock time is stated, else null'),
      }),
    )
    .describe('Real commitments by our team in the new message. Empty when none.'),
  document_requests: z
    .array(z.object({ item: z.string().describe('One concrete document asked from the client') }))
    .describe('Documents our team asks the client to send, one per document. Empty when none.'),
})

export const clientSchema = z.object({
  repeat_ask: z
    .object({
      item: z.string().describe('What the client is waiting for, a short key phrase'),
      repeats_message_id: z.string().nullable().describe('Id of the earlier client message in the context that first asked, or null'),
    })
    .nullable()
    .describe('Set only when the client asks again about something not yet delivered; otherwise null'),
})

export const deliverySchema = z.object({
  delivered_ids: z.array(z.string()).describe('Ids from OPEN ITEMS that this evidence clearly delivers or answers. Empty when none.'),
})

export type ObjectCallArgs = { system: string; prompt: string; schema: z.ZodType; schemaName: string }
export type ObjectCall = (args: ObjectCallArgs) => Promise<unknown>

/** The real call: generateObject on the given model, or model slot A, created at call time (never at import). */
function modelCall(model?: LanguageModel): ObjectCall {
  return async ({ system, prompt, schema, schemaName }) => {
    const { object } = await generateObject({
      model: model ?? getModel('A'),
      schema,
      schemaName,
      system,
      prompt,
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(FOLLOW_UP_TIMEOUT_MS),
    })
    return object
  }
}

// ---------------------------------------------------------------- cleanup (pure, exported for tests)

/** Masks, collapses whitespace, strips list bullets and quotes, caps at MAX_ITEM_CHARS. "" when nothing is left. */
export function cleanItem(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const s = maskCredentials(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*•]+\s*|\d{1,2}[.)]\s+)/u, '')
    .replace(/^["'“‘]+/u, '')
    .replace(/["'”’.]+$/u, '')
    .trim()
  return s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS).trim() : s
}

/** Cleans, drops empties, dedupes case-insensitively (first wins) and caps at MAX_ITEMS. */
export function dedupeItems<T extends { item: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const r of rows) {
    const item = cleanItem(r.item)
    const key = item.toLowerCase()
    if (!item || seen.has(key)) continue
    seen.add(key)
    out.push({ ...r, item })
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

/** A real calendar date in YYYY-MM-DD, not before `today` (when today is a valid date) and within a year of it. */
export function validDueDate(v: unknown, today?: string): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null
  if (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) {
    if (v < today) return null
    const t = new Date(`${today}T00:00:00Z`).getTime()
    if (!Number.isNaN(t) && d.getTime() - t > 366 * 86_400_000) return null
  }
  return v
}

/** "HH:MM" (24 hour), zero padded, else null. */
export function validDueTime(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, '0')}:${m[2]}` : null
}

function masked(m: ScanMessage): ScanMessage {
  return { ...m, body: maskCredentials(m.body ?? ''), sender_name: m.sender_name == null ? null : maskCredentials(m.sender_name) }
}

function maskedOpen(o: OpenItem): OpenItem {
  return { ...o, item: maskCredentials(o.item ?? '') }
}

// ---------------------------------------------------------------- the extractor

export function createFollowUpAI(deps: { model?: LanguageModel; call?: ObjectCall } = {}): FollowUpAI {
  const call = deps.call ?? modelCall(deps.model)

  /** One call, re-validated against the schema; retried once on a throw or an invalid object. */
  async function ask<S extends z.ZodType>(schema: S, schemaName: string, system: string, prompt: string): Promise<z.infer<S>> {
    return withOneRetry(async () => schema.parse(await call({ system, prompt, schema, schemaName })))
  }

  return {
    async team(msg, context, today): Promise<TeamExtraction> {
      if (!msg.body?.trim()) return { promises: [], document_requests: [] }
      const prompt = buildTeamPrompt(masked(msg), context.map(masked), today)
      const out = await ask(teamSchema, 'follow_up_team', TEAM_SYSTEM_PROMPT, prompt)
      return {
        promises: dedupeItems(out.promises).map((p) => ({
          item: p.item,
          due_date: validDueDate(p.due_date, today),
          due_time: validDueTime(p.due_time),
        })),
        document_requests: dedupeItems(out.document_requests).map((d) => ({ item: d.item })),
      }
    },

    async client(msg, context, open): Promise<ClientExtraction> {
      if (!msg.body?.trim()) return { repeat_ask: null }
      const prompt = buildClientPrompt(masked(msg), context.map(masked), open.map(maskedOpen))
      const out = await ask(clientSchema, 'follow_up_client', CLIENT_SYSTEM_PROMPT, prompt)
      if (!out.repeat_ask) return { repeat_ask: null }
      const item = cleanItem(out.repeat_ask.item)
      if (!item) return { repeat_ask: null }
      const ids = new Set(context.map((m) => m.message_id))
      const rid = out.repeat_ask.repeats_message_id
      return { repeat_ask: { item, repeats_message_id: rid && ids.has(rid) ? rid : null } }
    },

    async delivered(evidence, open): Promise<DeliveryCheck> {
      if (!open.length || !evidence.text?.trim()) return { delivered_ids: [] }
      const prompt = buildDeliveryPrompt({ ...evidence, text: maskCredentials(evidence.text) }, open.map(maskedOpen))
      const out = await ask(deliverySchema, 'follow_up_delivery', DELIVERY_SYSTEM_PROMPT, prompt)
      const ids = new Set(open.map((o) => o.id))
      return { delivered_ids: [...new Set(out.delivered_ids)].filter((id) => ids.has(id)) }
    },
  }
}

/** Default extractor on model slot A. Creating it reads no env and builds no model; that happens per call. */
export const followUpAI: FollowUpAI = createFollowUpAI()
