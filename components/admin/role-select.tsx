'use client'
import { useState, useTransition } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ROLE_LABELS, ROLES, type Role } from '@/lib/auth/types'
import { setUserRoleAction } from '@/app/(app)/admin/actions'

const NO_ROLE = '__none__'

/** Explicit role picker for one user. "No role set" clears app_metadata.role. Disabled for your own row. */
export function RoleSelect({
  userId,
  email,
  role,
  disabled,
}: {
  userId: string
  email: string
  role: Role | null
  disabled?: boolean
}) {
  const [value, setValue] = useState<string>(role ?? NO_ROLE)
  const [status, setStatus] = useState<{ kind: 'idle' | 'saved' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const [pending, startTransition] = useTransition()

  function onChange(next: string) {
    const previous = value
    setValue(next)
    setStatus({ kind: 'idle' })
    startTransition(async () => {
      const res = await setUserRoleAction(userId, next === NO_ROLE ? null : (next as Role))
      if (res.ok) setStatus({ kind: 'saved' })
      else {
        setValue(previous)
        setStatus({ kind: 'error', message: res.error })
      }
    })
  }

  return (
    <div className="flex flex-col gap-1">
      <Select value={value} onValueChange={onChange} disabled={disabled || pending}>
        <SelectTrigger size="sm" className="w-48" aria-label={`Role for ${email}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_ROLE}>No role set</SelectItem>
          {ROLES.map((r) => (
            <SelectItem key={r} value={r}>
              {ROLE_LABELS[r]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span aria-live="polite" className="min-h-4 text-xs">
        {pending && <span className="text-muted-foreground">Saving...</span>}
        {!pending && status.kind === 'saved' && <span className="text-success">Saved. Applies on their next page load.</span>}
        {!pending && status.kind === 'error' && <span className="text-destructive">{status.message}</span>}
      </span>
    </div>
  )
}
