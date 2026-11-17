import { describe, expect, it } from 'vitest'
import { HIDDEN } from '@/lib/ai/redact'
import { toConversationItem } from './conversations'
import { toDocumentItem } from './documents'
import { toMessageItem } from './messages'

// CLAUDE.md: never echo client passwords or credentials. Everything a screen shows comes through these mappers.
describe('credentials never reach a screen', () => {
  it('message text', () => {
    const m = toMessageItem(
      { message_id: 'm1', dedup_hash: 'w1', message_timestamp: '2026-11-17T05:00:00Z', body: 'GST portal OTP is 445566',
        sender_name: null, sender_phone: '918888888888', direction: 'incoming', message_type: 'chat', conversation_id: null },
      new Set(),
    )
    expect(m.body).toBe(`GST portal OTP is ${HIDDEN}`)
  })
  it('ticket title and summary', () => {
    const t = toConversationItem(
      { id: 't1', client_id: 'c1', va_id: null, title: 'Password: Abc@123 shared', summary: 'Client sent pwd hai xyz123',
        status: 'open', tag: null, fault: null, client_tone: null, va_tone: null, sla_breached: false, opened_at: '2026-11-17T05:00:00Z',
        opened_by: 'council', closed_at: null, last_message_at: '2026-11-17T05:00:00Z', last_message_direction: null, message_count: 1 },
      'Alpha',
    )
    expect(t.title).toBe(`Password: ${HIDDEN} shared`)
    expect(t.summary).toBe(`Client sent pwd hai ${HIDDEN}`)
  })
  it('file names stay readable (not masked)', () => {
    const d = toDocumentItem({ upload_id: 'd1', client_id: 'c1', file_name: 'Password protected statement.pdf', folder_name: 'Alpha',
      file_type: 'pdf', file_size: 1, uploaded_at: null, group_name: null })
    expect(d.fileName).toBe('Password protected statement.pdf')
    expect(d.path).toBe('Alpha/Password protected statement.pdf')
  })
  it('ordinary text is unchanged', () => {
    const m = toMessageItem(
      { message_id: 'm2', dedup_hash: 'w2', message_timestamp: '2026-11-17T05:00:00Z', body: 'GSTR-3B filed, ARN AA2910260012345',
        sender_name: null, sender_phone: null, direction: 'outgoing', message_type: 'chat', conversation_id: null },
      new Set(),
    )
    expect(m.body).toBe('GSTR-3B filed, ARN AA2910260012345')
  })
})
