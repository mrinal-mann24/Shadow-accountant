'use client'
import { useState, useTransition } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { assignClientAction } from '@/app/(app)/admin/actions'

const UNASSIGNED = '__unassigned__'

/** Accountant picker for one client. Saves on change, rolls back and shows the error if the save fails. */
export function AssignSelect({
  clientId,
  clientName,
  vaId,
  options,
}: {
  clientId: string
  clientName: string
  vaId: string | null
  options: { id: string; name: string }[]
}) {
  const [value, setValue] = useState(vaId ?? UNASSIGNED)
  const [status, setStatus] = useState<{ kind: 'idle' | 'saved' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const [pending, startTransition] = useTransition()

  function onChange(next: string) {
    const previous = value
    setValue(next)
    setStatus({ kind: 'idle' })
    startTransition(async () => {
      const res = await assignClientAction(clientId, next === UNASSIGNED ? null : next)
      if (res.ok) setStatus({ kind: 'saved' })
      else {
        setValue(previous)
        setStatus({ kind: 'error', message: res.error })
      }
    })
  }

  return (
    <div className="flex flex-col gap-1">
      <Select value={value} onValueChange={onChange} disabled={pending}>
        <SelectTrigger size="sm" className="w-48" aria-label={`Accountant for ${clientName}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span aria-live="polite" className="min-h-4 text-xs">
        {pending && <span className="text-muted-foreground">Saving...</span>}
        {!pending && status.kind === 'saved' && <span className="text-success">Saved</span>}
        {!pending && status.kind === 'error' && <span className="text-destructive">{status.message}</span>}
      </span>
    </div>
  )
}
