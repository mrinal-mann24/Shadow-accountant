'use client'
import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { TAGS } from '@/lib/council/types'
import { cn } from '@/lib/utils'
import { TAG_LABELS, type TicketActionState } from './ticket-intent'

type Action = (prev: TicketActionState, formData: FormData) => Promise<TicketActionState>

/** Close / reopen / change tag for one ticket. The server action is passed in from the page. */
export function TicketActions({
  id,
  status,
  tag,
  action,
  readOnlyNote,
}: {
  id: string
  status: string
  tag: string | null
  action: Action
  /** Set when the user cannot change tickets; shown instead of the actions. */
  readOnlyNote?: string | null
}) {
  const [state, formAction, pending] = useActionState(action, { ok: true, message: null })

  if (readOnlyNote) {
    return <p className="text-xs text-muted-foreground">{readOnlyNote}</p>
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      {status === 'open' ? (
        <Button type="submit" name="intent" value="close" variant="outline" size="sm" disabled={pending}>
          Close
        </Button>
      ) : (
        <Button type="submit" name="intent" value="reopen" variant="outline" size="sm" disabled={pending}>
          Reopen
        </Button>
      )}
      <label className="sr-only" htmlFor={`tag-${id}`}>
        Tag
      </label>
      <select
        id={`tag-${id}`}
        name="tag"
        defaultValue={tag ?? ''}
        disabled={pending}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="" disabled>
          Choose tag
        </option>
        {TAGS.map((t) => (
          <option key={t} value={t}>
            {TAG_LABELS[t]}
          </option>
        ))}
      </select>
      <Button type="submit" name="intent" value="tag" variant="ghost" size="sm" disabled={pending}>
        Change tag
      </Button>
      {pending && <span className="text-xs text-muted-foreground">Saving...</span>}
      {!pending && state.message && (
        <span role="status" className={cn('text-xs', state.ok ? 'text-success' : 'text-destructive')}>
          {state.message}
        </span>
      )}
    </form>
  )
}
