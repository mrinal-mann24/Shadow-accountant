import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ticketReadOnlyNote, filterTickets, sortTicketsBySlaLag } from '@/components/accountant/logic'
import { isTag, TAG_LABELS } from '@/components/accountant/ticket-intent'
import { TicketList } from '@/components/accountant/ticket-list'
import { PageHeader } from '@/components/accountant/ui'
import { requireUser } from '@/lib/auth/session'
import { TAGS } from '@/lib/council/types'
import { listConversations } from '@/lib/data'

export const metadata: Metadata = { title: 'Tickets' }
export const dynamic = 'force-dynamic'

type Params = { status?: string | string[]; tag?: string | string[]; q?: string | string[] }
const STATUSES = { open: 'Open', closed: 'Closed', all: 'All' } as const
type StatusFilter = keyof typeof STATUSES

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireUser()
  const sp = await searchParams
  const rawStatus = first(sp.status)
  const status: StatusFilter = rawStatus === 'closed' || rawStatus === 'all' ? rawStatus : 'open'
  const rawTag = first(sp.tag)
  const tag = isTag(rawTag) ? rawTag : undefined
  const q = first(sp.q)?.trim().slice(0, 100) ?? ''

  const now = new Date()
  const rows = await listConversations(user, { status: status === 'all' ? undefined : status, tag })
  const filtered = filterTickets(rows, q)
  const tickets = status === 'open' ? sortTicketsBySlaLag(filtered, now) : filtered
  const filtersOn = status !== 'open' || tag || q

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Tickets"
        description={`${tickets.length} ${status === 'all' ? '' : `${STATUSES[status].toLowerCase()} `}${tickets.length === 1 ? 'ticket' : 'tickets'}${
          status === 'open' ? ', most urgent first' : ', latest activity first'
        }`}
      />

      <form action="/tickets" className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor="status" className="text-xs text-muted-foreground">
            Status
          </label>
          <select id="status" name="status" defaultValue={status} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            {(Object.keys(STATUSES) as StatusFilter[]).map((s) => (
              <option key={s} value={s}>
                {STATUSES[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="tag" className="text-xs text-muted-foreground">
            Tag
          </label>
          <select id="tag" name="tag" defaultValue={tag ?? ''} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option value="">Any tag</option>
            {TAGS.map((t) => (
              <option key={t} value={t}>
                {TAG_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="q" className="text-xs text-muted-foreground">
            Search
          </label>
          <Input id="q" name="q" defaultValue={q} placeholder="Title, summary or client" />
        </div>
        <div className="flex gap-2">
          <Button type="submit">Apply</Button>
          {filtersOn && (
            <Button asChild variant="ghost">
              <Link href="/tickets">Reset</Link>
            </Button>
          )}
        </div>
      </form>

      <div className="rounded-lg border p-4">
        <TicketList
          tickets={tickets}
          now={now}
          readOnlyNote={ticketReadOnlyNote(user)}
          emptyText={filtersOn ? 'No tickets match these filters.' : 'No open tickets. Nice work.'}
        />
      </div>
    </div>
  )
}
