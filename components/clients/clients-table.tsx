// The clients table: header, rows (each a small client component for expand/collapse) and a footer count. No hooks.
import { cn } from '@/lib/utils'
import { ClientGroupRow } from './client-group-row'
import { GRID_NO_SENIOR, GRID_WITH_SENIOR } from './grid'
import type { ClientRowView } from './view'

export function ClientsTable({
  rows,
  showSenior,
  footer,
  className,
}: {
  rows: ClientRowView[]
  showSenior: boolean
  footer: string
  className?: string
}) {
  return (
    <section className={cn('overflow-hidden rounded-[18px] border bg-card', className)}>
      <div
        className={cn(
          'hidden gap-3 border-b border-[#EEF0F4] px-5 py-3 text-xs font-medium text-meta xl:grid',
          showSenior ? GRID_WITH_SENIOR : GRID_NO_SENIOR,
        )}
      >
        <span className="pl-[74px]">Client</span>
        {showSenior && <span>Senior</span>}
        <span>Groups</span>
        <span>Open</span>
        <span>Health</span>
        <span>Last message</span>
      </div>
      <ul>
        {rows.map((r) => (
          <ClientGroupRow key={r.id} row={r} showSenior={showSenior} />
        ))}
      </ul>
      <p className="border-t border-line-soft px-5 py-3.5 text-[13px] text-muted-foreground">{footer}</p>
    </section>
  )
}
