import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { chatErrorMessage, currentActivity, messageSources, messageText, plainText, toTurns } from './chat-utils'

const cite = (n: number, id: string) => ({ n, kind: 'message', id, clientId: 'c1', at: '2026-11-16T09:35:00Z', label: `L${n}` })

function assistant(parts: unknown[]): UIMessage {
  return { id: 'a1', role: 'assistant', parts } as UIMessage
}

describe('chat utils', () => {
  it('messageText joins text parts', () => {
    expect(messageText(assistant([{ type: 'text', text: 'GST filed ' }, { type: 'step-start' }, { type: 'text', text: '[1].' }]))).toBe(
      'GST filed [1].',
    )
  })

  it('messageSources reads citations and previews from finished tool parts only', () => {
    const m = assistant([
      {
        type: 'tool-searchMessages',
        toolCallId: 't1',
        state: 'output-available',
        input: { query: 'gst' },
        output: { items: [{ n: 1, citation: cite(1, 'm1'), text: 'GST return filed today' }] },
      },
      { type: 'tool-getFiles', toolCallId: 't2', state: 'input-available', input: {} },
      {
        type: 'tool-getFiles',
        toolCallId: 't3',
        state: 'output-available',
        input: {},
        output: { items: [{ n: 2, citation: { ...cite(2, 'f1'), kind: 'file' }, folder: 'Client Files/X' }] },
      },
    ])
    const s = messageSources(m)
    expect([...s.keys()]).toEqual([1, 2])
    expect(s.get(1)?.preview).toBe('GST return filed today')
    expect(s.get(2)?.preview).toBe('Client Files/X')
  })

  it('currentActivity shows the running tool until text arrives', () => {
    expect(currentActivity(null)).toBe(null)
    expect(currentActivity(assistant([{ type: 'tool-getTickets', toolCallId: 't', state: 'input-streaming' }]))).toBe('Reading tickets')
    expect(
      currentActivity(assistant([{ type: 'tool-getTickets', toolCallId: 't', state: 'output-available', input: {}, output: {} }])),
    ).toBe(null)
    expect(currentActivity(assistant([{ type: 'text', text: 'Answer' }]))).toBe(null)
  })

  it('toTurns sends role and text only, skipping empty turns', () => {
    const msgs = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'When was GST filed?' }] },
      assistant([{ type: 'tool-searchMessages', toolCallId: 't', state: 'input-available', input: {} }]),
    ] as UIMessage[]
    expect(toTurns(msgs)).toEqual([{ role: 'user', text: 'When was GST filed?' }])
  })

  it('chatErrorMessage reads the route JSON error', () => {
    expect(chatErrorMessage(new Error('{"error":"This client is not in your list of clients."}'))).toBe(
      'This client is not in your list of clients.',
    )
    expect(chatErrorMessage(new Error('<html>502</html>'))).toBe('Could not get an answer. Please try again.')
  })

  it('plainText drops bold and heading markers', () => {
    expect(plainText('## Summary\n**GST** filed [1]')).toBe('Summary\nGST filed [1]')
  })
})
