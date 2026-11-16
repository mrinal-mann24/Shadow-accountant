'use client'
import { useState, useTransition } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { retryProcessingAction } from '@/app/(app)/engineer/actions'

/** Puts one failed processing row back to pending. The next council run picks it up. */
export function RetryButton({ messageId }: { messageId: string }) {
  const [state, setState] = useState<{ kind: 'idle' | 'queued' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const [pending, startTransition] = useTransition()

  if (state.kind === 'queued') {
    return <span className="text-xs text-success">Queued for the next council run</span>
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`Retry message ${messageId}`}
        onClick={() =>
          startTransition(async () => {
            const res = await retryProcessingAction(messageId)
            setState(res.ok ? { kind: 'queued' } : { kind: 'error', message: res.error })
          })
        }
      >
        <RotateCcw aria-hidden />
        {pending ? 'Retrying...' : 'Retry'}
      </Button>
      {state.kind === 'error' && <span className="text-xs text-destructive">{state.message}</span>}
    </div>
  )
}
