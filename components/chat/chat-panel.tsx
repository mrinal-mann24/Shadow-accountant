'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from 'ai'
import { ArrowRight, Send, Sparkles, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
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

/** Three pulsing dots while the answer is on its way, with what the assistant is doing. */
function TypingDots({ label, dark }: { label: string; dark: boolean }) {
  return (
    <p className="flex items-center gap-1.5 pl-1" aria-live="polite">
      {[0, 0.2, 0.4].map((d) => (
        <span
          key={d}
          className={cn('anim-typing size-1.5 rounded-full', dark ? 'bg-[#8ea2ff]' : 'bg-primary')}
          style={{ animationDelay: `${d}s` }}
          aria-hidden
        />
      ))}
      <span className={cn('ml-1 text-xs', dark ? 'text-[#9aa1af]' : 'text-muted-foreground')}>{label}</span>
    </p>
  )
}

/**
 * Ask AI chat. With `clients` it shows a client picker (the Ask AI page). With `fixedClient` it is the dark
 * "Ask Shadow" panel on a client page: locked to that client, no picker and no address change.
 */
export function ChatPanel({
  clients = [],
  initialClientId = null,
  fixedClient,
}: {
  clients?: { id: string; name: string }[]
  initialClientId?: string | null
  fixedClient?: { id: string; name: string }
}) {
  const router = useRouter()
  const [clientId, setClientId] = useState<string | null>(fixedClient?.id ?? initialClientId)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [streaming, setStreaming] = useState<UIMessage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const chatIdRef = useRef(newId('chat'))
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

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

  /** Keep the newest text in view. Inside the panel only the panel scrolls, never the client page. */
  function followBottom() {
    const box = scrollRef.current
    if (box) box.scrollTop = box.scrollHeight
    else bottomRef.current?.scrollIntoView({ block: 'end' })
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
        followBottom()
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

  if (fixedClient) {
    return (
      <aside
        aria-label={`Ask Shadow about ${fixedClient.name}`}
        className="anim-rise anim-d3 flex min-w-0 flex-col gap-3.5 rounded-[20px] bg-ink p-5 text-white lg:sticky lg:top-20"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="size-[18px] text-[#8ea2ff]" aria-hidden />
          <strong className="text-[15px] font-semibold">Ask Shadow</strong>
          <span className="ml-auto max-w-[55%] truncate text-xs text-[#9aa1af]">{fixedClient.name} only</span>
        </div>

        <div ref={scrollRef} className="flex max-h-[26rem] min-h-0 flex-col gap-3.5 overflow-y-auto pr-0.5">
          {shown.length === 0 ? (
            <p className="text-[13px] leading-relaxed text-[#c3c8d2]">
              Ask about this client&apos;s WhatsApp messages, tickets, files and meetings. Every answer shows its sources.
              Shadow only reads; it never sends messages or changes anything.
            </p>
          ) : (
            shown.map((m) => <ChatMessage key={m.id} message={m} sources={sources} tone="dark" />)
          )}
          {activity && <TypingDots label={activity} dark />}
          {error && (
            <p className="rounded-xl border border-[#5c2626] bg-[#2a1414] px-3 py-2 text-sm text-[#fca5a5]" role="alert">
              {error}
            </p>
          )}
        </div>

        {shown.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                disabled={busy}
                className="press rounded-full border border-ink-line px-2.5 py-1.5 text-left text-xs text-[#d6dae3] hover:border-[#3b4252] hover:bg-ink-2 disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <form
          className="flex items-end gap-2 rounded-xl border border-ink-line bg-ink-2 p-1.5 pl-3 focus-within:border-[#4b5fd6]"
          onSubmit={(e) => {
            e.preventDefault()
            void ask(input)
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void ask(input)
              }
            }}
            placeholder={`Ask about ${fixedClient.name}`}
            aria-label={`Ask about ${fixedClient.name}`}
            maxLength={4000}
            rows={1}
            className="max-h-32 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm text-white outline-none placeholder:text-[#7c8494]"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              aria-label="Stop"
              className="press flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-ink-line text-white"
            >
              <Square className="size-3.5" aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send"
              className="press flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary text-white disabled:opacity-40"
            >
              <ArrowRight className="size-3.5" strokeWidth={2.4} aria-hidden />
            </button>
          )}
        </form>
        <p className="text-xs text-[#9aa1af]">If Shadow cannot find it, it says so. It never guesses.</p>
      </aside>
    )
  }

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

      <div className="flex flex-1 flex-col gap-5 rounded-2xl border border-border bg-card p-4">
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
        {activity && <TypingDots label={activity} dark={false} />}
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
