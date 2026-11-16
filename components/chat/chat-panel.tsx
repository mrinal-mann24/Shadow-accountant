'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from 'ai'
import { Loader2, Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ChatMessage } from './chat-message'
import { chatErrorMessage, currentActivity, messageSources, toTurns, type CitedSource } from './chat-utils'

const ALL = '__all'

const SUGGESTIONS = [
  'What is pending from this client right now?',
  'When did they last share a bank statement?',
  'Summarise the open tickets.',
]

let idCounter = 0
function newId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now()}-${idCounter}`
}

export function ChatPanel({ clients, initialClientId }: { clients: { id: string; name: string }[]; initialClientId: string | null }) {
  const router = useRouter()
  const [clientId, setClientId] = useState<string | null>(initialClientId)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [streaming, setStreaming] = useState<UIMessage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const chatIdRef = useRef(newId('chat'))
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages: ms, body }) => ({
          body: { clientId: (body?.clientId as string | null | undefined) ?? null, messages: toTurns(ms) },
        }),
      }),
    [],
  )

  // Sources from every answer so far, so a repeated number still opens its source.
  const sources = useMemo(() => {
    const all = new Map<number, CitedSource>()
    for (const m of streaming ? [...messages, streaming] : messages) {
      if (m.role === 'assistant') for (const [n, s] of messageSources(m)) all.set(n, s)
    }
    return all
  }, [messages, streaming])

  function pickClient(value: string) {
    const next = value === ALL ? null : value
    if (busy) abortRef.current?.abort()
    setClientId(next)
    setMessages([])
    setStreaming(null)
    setError(null)
    chatIdRef.current = newId('chat')
    router.replace(next ? `/ask?client=${encodeURIComponent(next)}` : '/ask', { scroll: false })
  }

  async function ask(question: string) {
    const text = question.trim()
    if (!text || busy) return
    setError(null)
    setInput('')
    const userMsg: UIMessage = { id: newId('user'), role: 'user', parts: [{ type: 'text', text }] }
    const history = [...messages, userMsg]
    setMessages(history)
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    const chatId = chatIdRef.current
    const sameChat = () => chatIdRef.current === chatId
    let last: UIMessage | null = null
    try {
      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId,
        messageId: undefined,
        messages: history,
        abortSignal: controller.signal,
        body: { clientId },
      })
      for await (const m of readUIMessageStream<UIMessage>({
        stream,
        onError: (e) => {
          if (sameChat()) setError(chatErrorMessage(e))
        },
      })) {
        if (!sameChat()) break
        last = m
        setStreaming(m)
        bottomRef.current?.scrollIntoView({ block: 'end' })
      }
    } catch (e) {
      if (!controller.signal.aborted && sameChat()) setError(chatErrorMessage(e))
    } finally {
      const final = last
      // A switch to another client starts a new chat: drop the old answer instead of adding it there.
      if (final && sameChat()) setMessages((prev) => [...prev, { ...final, id: final.id || newId('assistant') }])
      setStreaming(null)
      setBusy(false)
      abortRef.current = null
    }
  }

  const activity = busy ? (currentActivity(streaming) ?? (streaming ? null : 'Thinking')) : null
  const shown = streaming ? [...messages, streaming] : messages

  return (
    <div className="flex min-h-[60vh] flex-col gap-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
        <label htmlFor="chat-client" className="text-sm text-muted-foreground">
          Client
        </label>
        <Select value={clientId ?? ALL} onValueChange={pickClient}>
          <SelectTrigger id="chat-client" className="w-full sm:w-80">
            <SelectValue placeholder="All my clients" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All my clients</SelectItem>
            {clients.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-1 flex-col gap-5 rounded-lg border border-border p-4">
        {shown.length === 0 ? (
          <div className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              Ask about {clientId ? 'this client' : 'any of your clients'}: WhatsApp messages, tickets, files and meetings. Every
              answer shows its sources. The assistant only reads; it never sends messages or changes anything.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} type="button" variant="outline" size="sm" onClick={() => ask(s)} disabled={busy}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          shown.map((m) => <ChatMessage key={m.id} message={m} sources={sources} />)
        )}
        {activity && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {activity}
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          void ask(input)
        }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void ask(input)
            }
          }}
          placeholder="Ask a question about your client"
          aria-label="Your question"
          maxLength={4000}
          rows={2}
          className="min-h-11 flex-1 resize-none"
        />
        {busy ? (
          <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
            <Square aria-hidden />
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()}>
            <Send aria-hidden />
            Ask
          </Button>
        )}
      </form>
    </div>
  )
}
