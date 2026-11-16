'use client'
import { useTransition } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { setViewAs } from '@/lib/auth/view-as'

/** Engineer only: pick an accountant to view the app as (read-only). */
export function ViewAsSelector({ options }: { options: { vaId: string; name: string }[] }) {
  const [pending, startTransition] = useTransition()
  if (options.length === 0) return null
  return (
    <Select disabled={pending} onValueChange={(vaId) => startTransition(() => setViewAs(vaId))}>
      <SelectTrigger size="sm" className="w-44" aria-label="View as accountant">
        <SelectValue placeholder={pending ? 'Switching...' : 'View as...'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.vaId} value={o.vaId}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
