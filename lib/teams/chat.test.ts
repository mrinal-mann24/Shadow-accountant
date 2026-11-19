import { describe, expect, it } from 'vitest'
import { parseSaveAction, saveCard } from './cards'
import {
  cleanLongText,
  HISTORY_TURN_CHARS,
  historyTurns,
  MAX_MESSAGE_CHARS,
  NEW_CHAT,
  pendingExpired,
  textToSave,
  validMeetingDate,
  type SaveProposal,
} from './chat'

const proposal = (o: Partial<SaveProposal> = {}): SaveProposal => ({
  clientId: 'c1',
  clientName: 'Acme',
  title: 'Call',
  meetingDate: null,
  source: 'this_message',
  startsWith: null,
  ...o,
})

describe('cleanLongText', () => {
  it('keeps line breaks from <br> and paragraphs, drops mentions and tags, decodes entities', () => {
    const html = '<at>Shadow</at> save this<p>Ravi:  we pay &amp; file</p><div>Asha: ok&nbsp;&lt;done&gt;</div><br/><br/><br/>end'
    expect(cleanLongText(html)).toBe('save this\nRavi: we pay & file\nAsha: ok <done>\n\nend')
  })
  it('gives one line per Teams paragraph', () => {
    expect(cleanLongText('<p>Ravi: hello</p><p>Asha: hi</p>')).toBe('Ravi: hello\nAsha: hi')
  })
  it('keeps plain new lines, collapses 3+ blank lines, and caps the length', () => {
    expect(cleanLongText('a\r\nb\n\n\n\nc')).toBe('a\nb\n\nc')
    expect(cleanLongText('z'.repeat(MAX_MESSAGE_CHARS + 10))).toHaveLength(MAX_MESSAGE_CHARS)
    expect(cleanLongText(undefined)).toBe('')
  })
})

describe('historyTurns', () => {
  it('maps rows to turns, removes old citation numbers and cuts long turns', () => {
    const t = historyTurns([
      { kind: 'user', content: 'q [1]', created_at: '' },
      { kind: 'assistant', content: 'Filed on 12 Nov [2][3].', created_at: '' },
      { kind: 'assistant', content: '[1]', created_at: '' },
      { kind: 'user', content: 'x'.repeat(HISTORY_TURN_CHARS + 50), created_at: '' },
    ])
    expect(t[0]).toEqual({ role: 'user', text: 'q [1]' })
    expect(t[1]).toEqual({ role: 'assistant', text: 'Filed on 12 Nov .' })
    expect(t).toHaveLength(3) // the empty assistant turn is dropped
    expect(t[2].text.endsWith('... (cut)')).toBe(true)
  })
})

describe('textToSave', () => {
  const msg = 'Please store this for Acme\nRavi: We will pay GST on Friday.\nAsha: Noted.'
  it('starts at the first words of the transcript when they are found', () => {
    expect(textToSave(proposal({ startsWith: 'ravi:  we will pay' }), msg, [])).toBe('Ravi: We will pay GST on Friday.\nAsha: Noted.')
  })
  it('keeps the whole message when the words are not found or too short', () => {
    expect(textToSave(proposal({ startsWith: 'not in there' }), msg, [])).toBe(msg)
    expect(textToSave(proposal({ startsWith: 'Pl' }), msg, [])).toBe(msg)
  })
  it('uses the previous user turn for previous_message', () => {
    const history = [
      { kind: 'user' as const, content: 'Ravi: the earlier transcript text', created_at: '' },
      { kind: 'assistant' as const, content: 'Which client?', created_at: '' },
    ]
    expect(textToSave(proposal({ source: 'previous_message' }), 'Acme', history)).toBe('Ravi: the earlier transcript text')
    expect(textToSave(proposal({ source: 'previous_message' }), 'Acme', [])).toBeNull()
  })
  it('returns null for text too short to be worth saving', () => {
    expect(textToSave(proposal(), 'save it', [])).toBeNull()
  })
})

describe('validMeetingDate and pendingExpired', () => {
  it('accepts real past dates only', () => {
    expect(validMeetingDate('2026-11-18', '2026-11-19')).toBe('2026-11-18')
    expect(validMeetingDate('2026-11-19', '2026-11-19')).toBe('2026-11-19')
    expect(validMeetingDate('2026-11-20', '2026-11-19')).toBeNull()
    expect(validMeetingDate('2026-02-30', '2026-11-19')).toBeNull()
    expect(validMeetingDate('18 Nov', '2026-11-19')).toBeNull()
    expect(validMeetingDate(undefined, '2026-11-19')).toBeNull()
  })
  it('expires after 24 hours', () => {
    const p = { id: 'p', email: 'a', content: 'x', meta: { clientId: 'c', clientName: 'C', title: 't', meetingDate: null }, createdAt: '2026-11-18T06:00:00Z' }
    expect(pendingExpired(p, new Date('2026-11-19T05:59:00Z'))).toBe(false)
    expect(pendingExpired(p, new Date('2026-11-19T06:01:00Z'))).toBe(true)
    expect(pendingExpired({ ...p, createdAt: 'bad' }, new Date())).toBe(true)
  })
  it('recognises the new chat command', () => {
    expect(NEW_CHAT.test('New chat')).toBe(true)
    expect(NEW_CHAT.test('reset')).toBe(true)
    expect(NEW_CHAT.test('new chat about Acme')).toBe(false)
  })
})

describe('saveCard and parseSaveAction', () => {
  const view = {
    pendingId: 'p-1',
    clientId: 'c1',
    clientName: 'Acme',
    title: 'Call [link](https://evil.test)',
    meetingDate: '2026-11-18',
    content: 'Ravi: password: Abc@123\nAsha: ok',
  }
  it('asks to confirm with Save and Cancel, masks credentials and keeps client text plain', () => {
    const c = saveCard(view, { siteUrl: 'https://shadow.example' })
    const json = JSON.stringify(c)
    expect(json).toContain('Save to Acme?')
    expect(json).toContain('18 Nov 2026')
    expect(json).not.toContain('Abc@123')
    expect(json).not.toContain('](https://evil.test)')
    const actions = c.actions as { title: string; verb: string; data: unknown }[]
    expect(actions.map((a) => a.title)).toEqual(['Save', 'Cancel'])
    expect(actions[0]).toMatchObject({ verb: 'save', data: { action: 'save', pendingId: 'p-1' } })
  })
  it('shows who saved or cancelled instead of buttons', () => {
    const saved = saveCard(view, { siteUrl: 'https://shadow.example', handled: { action: 'saved', by: 'Asha', at: '2026-11-18T06:00:00Z' } })
    expect(JSON.stringify(saved)).toContain('Saved to Acme by Asha')
    expect((saved.actions as { type: string }[]).map((a) => a.type)).toEqual(['Action.OpenUrl'])
    const cancelled = saveCard(view, { siteUrl: 'https://shadow.example', handled: { action: 'cancelled', by: 'Asha', at: '2026-11-18T06:00:00Z' } })
    expect(cancelled.actions).toEqual([])
  })
  it('parses only valid save clicks', () => {
    const v = (data: unknown, verb = 'save') => ({ action: { type: 'Action.Execute', verb, data } })
    expect(parseSaveAction(v({ action: 'save', pendingId: 'p-1' }))).toEqual({ action: 'save', pendingId: 'p-1' })
    expect(parseSaveAction(v({ action: 'drop', pendingId: 'p-1' }))).toBeNull()
    expect(parseSaveAction(v({ action: 'save', pendingId: 'p-1' }, 'ticket'))).toBeNull()
    expect(parseSaveAction(null)).toBeNull()
  })
})
