import type { Metadata } from 'next'
import { ChatPanel } from '@/components/chat/chat-panel'
import { PageHeader } from '@/components/accountant/ui'
import { requireUser } from '@/lib/auth/session'
import { listClients } from '@/lib/data'

export const metadata: Metadata = { title: 'Ask AI' }
export const dynamic = 'force-dynamic'

export default async function AskPage({ searchParams }: { searchParams: Promise<{ client?: string | string[] }> }) {
  const user = await requireUser()
  const [clients, sp] = await Promise.all([listClients(user, { status: 'all' }), searchParams])
  const options = clients.map((c) => ({ id: c.id, name: c.name }))
  const requested = typeof sp.client === 'string' ? sp.client : null
  const initialClientId = requested && options.some((c) => c.id === requested) ? requested : null

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Ask AI"
        description="Answers come only from your clients' messages, tickets, files and meetings, with a source for every point."
      />
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">You have no clients assigned yet, so there is nothing to ask about.</p>
      ) : (
        <ChatPanel key={initialClientId ?? 'all'} clients={options} initialClientId={initialClientId} />
      )}
    </div>
  )
}
