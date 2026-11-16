import { Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { clearViewAs } from '@/lib/auth/view-as'

/** Shown on every page while an engineer is viewing as an accountant. */
export function ViewAsBanner({ name }: { name: string }) {
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 bg-warning px-4 py-2 text-sm text-white">
      <span className="flex items-center gap-2">
        <Eye className="size-4" aria-hidden />
        You are viewing as <strong>{name}</strong>. Read only: changes are turned off.
      </span>
      <form action={clearViewAs}>
        <Button type="submit" size="xs" variant="outline" className="border-white bg-transparent text-white hover:bg-white/15 hover:text-white">
          Stop viewing as
        </Button>
      </form>
    </div>
  )
}
