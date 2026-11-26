'use client'
// "Draft reply" for one ticket: the AI writes a short WhatsApp reply from this client's own messages and tickets.
// The accountant edits and copies it; nothing is sent or stored. The server action is passed in from the list.
import Link from 'next/link'
import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import type { DraftReply, DraftReplyResult } from '@/lib/reply/types'
import { cn } from '@/lib/utils'

type Action = (ticketId: string) => Promise<DraftReplyResult>

export function DraftReplyButton({
  ticketId,
  title,
  action,
  size = 'sm',
  className,
}: {
  ticketId: string
  title: string
  action: Action
  /** 'lg' matches the primary button in the Tickets side panel. */
  size?: 'sm' | 'lg'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [draft, setDraft] = useState<DraftReply | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function run() {
    setError(null)
    setCopied(false)
    startTransition(async () => {
      try {
        const r = await action(ticketId)
        if (r.ok) {
          setDraft(r.draft)
          setText(r.draft.reply)
        } else {
          setDraft(null)
          setError(r.message)
        }
      } catch {
        setDraft(null)
        setError('Could not draft a reply. Please try again.')
      }
    })
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setError('Could not copy. Select the text and copy it yourself.')
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size}
        className={cn('press', size === 'lg' && 'h-11 rounded-xl px-4 text-[14px]', className)}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true)
          if (!draft && !pending) run()
        }}
      >
        Draft reply
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle>Draft reply</DialogTitle>
            <DialogDescription className="wrap-break-word">
              {title}. Written by AI from this client&apos;s messages and tickets. Check it, edit it and send it yourself on WhatsApp.
            </DialogDescription>
          </DialogHeader>

          {pending && (
            <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
              Writing a draft
              <span className="flex gap-0.5" aria-hidden>
                <span className="anim-typing size-1 rounded-full bg-muted-foreground" />
                <span className="anim-typing anim-d2 size-1 rounded-full bg-muted-foreground" />
                <span className="anim-typing anim-d4 size-1 rounded-full bg-muted-foreground" />
              </span>
            </p>
          )}

          {!pending && error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {!pending && draft && (
            <div className="flex flex-col gap-3">
              {(draft.confidence === 'low' || draft.warnings.length > 0) && (
                <div className="anim-drop rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm text-[#8A4205]">
                  <p className="font-medium">Check before sending</p>
                  <ul className="mt-1 list-disc pl-5">
                    {draft.confidence === 'low' && draft.warnings.length === 0 && <li>The AI is not sure about this draft.</li>}
                    {draft.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {draft.check && (
                <p className="text-sm">
                  <span className="font-medium">To confirm: </span>
                  {draft.check}
                </p>
              )}
              <label htmlFor={`draft-${ticketId}`} className="sr-only">
                Reply text
              </label>
              <Textarea
                id={`draft-${ticketId}`}
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setCopied(false)
                }}
                rows={6}
                className="rounded-xl"
              />
              {draft.sources.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Based on</p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {draft.sources.map((s) => (
                      <li key={`${s.kind}-${s.id}`}>
                        {s.link ? (
                          <Link href={s.link} className="text-primary hover:underline">
                            {s.label}
                          </Link>
                        ) : (
                          s.label
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={run} disabled={pending}>
              {draft || error ? 'Try again' : 'Draft'}
            </Button>
            {draft && (
              <Button type="button" size="sm" className="press" onClick={copy} disabled={pending || !text.trim()}>
                {copied ? 'Copied' : 'Copy reply'}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
