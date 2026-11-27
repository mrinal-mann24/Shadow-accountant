'use client'
// "Suggested reply" in the Tickets panel (AI reply drafts): the reply our team would send, written in this client's
// style, ready when the ticket opens. The accountant edits it and copies it into WhatsApp; Shadow never sends it.
// Copying records what was copied (as is, or edited) and that is how the next drafts learn. Server actions are passed
// in from the page.
import { Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { SuggestionAction } from '@/lib/data/reply-suggestions'
import type { SuggestResult } from '@/lib/reply/suggest'
import { cn } from '@/lib/utils'
import { findPlaceholders } from './logic'

type SuggestAction = (ticketId: string, force?: boolean) => Promise<SuggestResult>
type RecordAction = (id: string, action: SuggestionAction, finalText: string | null) => Promise<{ ok: boolean; message: string | null }>
type Ok = Extract<SuggestResult, { ok: true }>

function builtOn(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(d)
}

export function SuggestedReply({
  ticketId,
  clientName,
  suggest,
  record,
  readOnly,
}: {
  ticketId: string
  clientName: string
  suggest: SuggestAction
  record: RecordAction
  /** Viewing as someone: the reply shows, nothing is recorded. */
  readOnly: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<Ok | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const started = useRef(false)

  function run(force: boolean) {
    setError(null)
    setNote(null)
    setCopied(false)
    startTransition(async () => {
      try {
        const r = await suggest(ticketId, force)
        if (r.ok) {
          setResult(r)
          setText(r.text)
        } else {
          setResult(null)
          setError(r.message)
        }
      } catch {
        setResult(null)
        setError('Could not write a suggested reply. Please try again.')
      }
    })
  }

  // Ready when the ticket opens: the page remounts this per ticket (key), so it runs once per ticket.
  useEffect(() => {
    if (started.current) return
    started.current = true
    run(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function copy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setError('Could not copy. Select the text and copy it yourself.')
      return
    }
    if (readOnly || !result.suggestionId) return
    const edited = text.trim() !== result.draft.trim()
    const r = await record(result.suggestionId, edited ? 'edited' : 'copied', text)
    if (!r.ok && r.message) setNote(r.message)
    else if (edited) setNote('Copied. Your edit will help the next drafts.')
  }

  function regenerate() {
    // An untouched suggestion that is replaced counts as "not useful".
    if (result?.suggestionId && !readOnly && !copied && text.trim() === result.draft.trim()) {
      void record(result.suggestionId, 'discarded', null)
    }
    run(true)
  }

  const placeholders = result ? findPlaceholders(text) : []

  return (
    <section aria-label="Suggested reply" className="anim-rise shrink-0 rounded-2xl border border-primary/25 bg-primary-soft/40 p-3.5">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="size-4 text-primary" aria-hidden />
        <h3 className="text-[13px] font-semibold">Suggested reply</h3>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {result
            ? `${clientName} style guide v${result.guideVersion}${builtOn(result.guideBuiltAt) ? `, ${builtOn(result.guideBuiltAt)}` : ''}`
            : ''}
        </span>
      </div>

      {pending && (
        <p role="status" className="flex items-center gap-1.5 py-3 text-sm text-muted-foreground">
          Writing a reply in {clientName}&apos;s style
          <span className="flex gap-0.5" aria-hidden>
            <span className="anim-typing size-1 rounded-full bg-muted-foreground" />
            <span className="anim-typing anim-d2 size-1 rounded-full bg-muted-foreground" />
            <span className="anim-typing anim-d4 size-1 rounded-full bg-muted-foreground" />
          </span>
        </p>
      )}

      {!pending && error && (
        <p role="alert" className="py-2 text-sm text-muted-foreground">
          {error}
        </p>
      )}

      {!pending && result && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`suggest-${ticketId}`} className="sr-only">
            Suggested reply text
          </label>
          <Textarea
            id={`suggest-${ticketId}`}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setCopied(false)
              setNote(null)
            }}
            rows={Math.min(8, Math.max(3, Math.ceil(text.length / 60)))}
            className="rounded-xl bg-card text-[13px] leading-relaxed"
          />
          {placeholders.length > 0 && (
            <p className="rounded-lg border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-xs text-[#8A4205]">
              Fill before sending: {placeholders.join(', ')}
            </p>
          )}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {result && !pending && (
          <Button type="button" size="sm" className="press" onClick={copy} disabled={!text.trim()}>
            {copied ? 'Copied' : 'Copy reply'}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={result ? regenerate : () => run(false)} disabled={pending}>
          {result ? 'Regenerate' : 'Try again'}
        </Button>
        <span className={cn('text-[11px] text-muted-foreground', note && 'text-foreground')}>
          {note ?? 'Shadow never sends this. Check it, then send it on WhatsApp.'}
        </span>
      </div>
    </section>
  )
}
