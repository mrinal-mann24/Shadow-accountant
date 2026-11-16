'use client'
import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { setCouncilEnabledAction } from '@/app/(app)/engineer/actions'

/** On / off switch for the ticket council on one client. Rolls back if the save fails. */
export function CouncilToggle({ clientId, clientName, enabled }: { clientId: string; clientName: string; enabled: boolean }) {
  const [on, setOn] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function toggle() {
    const next = !on
    setOn(next)
    setError(null)
    startTransition(async () => {
      const res = await setCouncilEnabledAction(clientId, next)
      if (!res.ok) {
        setOn(!next)
        setError(res.error)
      }
    })
  }

  return (
    <div className="flex items-center justify-end gap-3">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <span className={on ? 'text-sm font-medium' : 'text-sm text-muted-foreground'}>{on ? 'On' : 'Off'}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        role="switch"
        aria-checked={on}
        aria-label={`Ticket council for ${clientName}`}
        disabled={pending}
        onClick={toggle}
      >
        {pending ? 'Saving...' : on ? 'Turn off' : 'Turn on'}
      </Button>
    </div>
  )
}
