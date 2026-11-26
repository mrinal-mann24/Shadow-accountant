'use client'
import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { TAGS } from '@/lib/council/types'
import { cn } from '@/lib/utils'
import { TAG_LABELS, type TicketActionState } from './ticket-intent'

type Action = (prev: TicketActionState, formData: FormData) => Promise<TicketActionState>

/**
 * Close / reopen / change tag for one ticket. The server action is passed in from the page.
 * `layout="panel"` is the Tickets side panel: Close (or Reopen) is the one primary action in brand blue.
 * The default `inline` layout is for lists with many rows, so nothing there is primary.
 */
export function TicketActions({
  id,
  status,
  tag,
  action,
  readOnlyNote,
  layout = 'inline',
  children,
}: {
  id: string
  status: string
  tag: string | null
  action: Action
  /** Set when the user cannot change tickets; shown instead of the actions. */
  readOnlyNote?: string | null
  layout?: 'inline' | 'panel'
  /** Extra controls placed next to the primary action in the panel layout (for example Draft reply). */
  children?: React.ReactNode
}) {
  const [state, formAction, pending] = useActionState(action, { ok: true, message: null })

  if (readOnlyNote) {
    return (
      <div className={cn('flex flex-wrap items-center gap-2', layout === 'panel' && 'flex-col items-stretch')}>
        {layout === 'panel' && children}
        <p className="text-xs text-muted-foreground">{readOnlyNote}</p>
      </div>
    )
  }

  const panel = layout === 'panel'
  const open = status === 'open'
  const selectId = `tag-${layout}-${id}`

  const statusButton = (
    <Button
      type="submit"
      name="intent"
      value={open ? 'close' : 'reopen'}
      variant={panel ? 'default' : 'outline'}
      size={panel ? 'lg' : 'sm'}
      disabled={pending}
      className={cn(
        'press',
        panel && 'h-11 flex-1 rounded-xl text-[14px] shadow-[0_8px_20px_-10px_rgba(49,77,208,0.7)] hover:bg-primary-hover',
      )}
    >
      {open ? (panel ? 'Close ticket' : 'Close') : panel ? 'Reopen ticket' : 'Reopen'}
    </Button>
  )

  const tagControls = (
    <div className="flex items-center gap-2">
      <label className={panel ? 'text-xs text-muted-foreground' : 'sr-only'} htmlFor={selectId}>
        Tag
      </label>
      <select
        id={selectId}
        name="tag"
        defaultValue={tag ?? ''}
        disabled={pending}
        className={cn(
          'rounded-lg border border-input bg-card px-2 text-sm',
          panel ? 'h-10 min-w-0 flex-1 rounded-xl' : 'h-8',
        )}
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
      <Button
        type="submit"
        name="intent"
        value="tag"
        variant={panel ? 'outline' : 'ghost'}
        size="sm"
        disabled={pending}
        className={cn('press', panel && 'h-10 rounded-xl px-3.5')}
      >
        Change tag
      </Button>
    </div>
  )

  const feedback = (
    <>
      {pending && <span className="text-xs text-muted-foreground">Saving...</span>}
      {!pending && state.message && (
        <span role="status" className={cn('text-xs', state.ok ? 'text-success' : 'text-destructive')}>
          {state.message}
        </span>
      )}
    </>
  )

  if (panel) {
    // Two small forms sharing one action state, so the extra controls (children) sit outside any form.
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <form action={formAction} className="flex min-w-40 flex-1">
            <input type="hidden" name="id" value={id} />
            {statusButton}
          </form>
          {children}
        </div>
        <form action={formAction}>
          <input type="hidden" name="id" value={id} />
          {tagControls}
        </form>
        <div className="min-h-4">{feedback}</div>
      </div>
    )
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      {statusButton}
      {tagControls}
      {feedback}
    </form>
  )
}
