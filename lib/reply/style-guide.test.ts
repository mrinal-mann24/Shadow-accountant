import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@/lib/data/types'
import { correctionsBlock, maskNumbers } from './chat-text'
import { buildSuggestPrompt, DRAFT_PROMPTS, SUGGEST_PROMPT_VERSION } from './suggest-prompt'
import {
  buildGuidePrompt,
  guideLooksComplete,
  guideSettingKey,
  parsePilotClients,
  parseStoredGuide,
  qaPairs,
  serializeGuide,
  tidyGuide,
} from './style-guide'

function msg(id: string, at: string, direction: 'incoming' | 'outgoing', body: string): MessageItem {
  return {
    id,
    waMessageId: id,
    at,
    body,
    senderName: null,
    direction,
    storedDirection: direction,
    fromTeam: direction === 'outgoing',
    messageType: 'chat',
    conversationId: null,
  }
}

describe('stored guide', () => {
  const g = { guide: '## 1. x\n## 7. y', version: 3, model: 'm', builtAt: '2026-11-27T10:00:00Z', messages: 10, corrections: 2 }
  it('round-trips and rejects bad values', () => {
    expect(parseStoredGuide(serializeGuide(g))).toEqual(g)
    expect(parseStoredGuide(null)).toBeNull()
    expect(parseStoredGuide('not json')).toBeNull()
    expect(parseStoredGuide(JSON.stringify({ guide: '', version: 1 }))).toBeNull()
    expect(parseStoredGuide(JSON.stringify({ guide: 'x' }))).toBeNull()
  })
  it('keys one settings row per client', () => {
    expect(guideSettingKey('c1')).toBe('reply_style_guide:c1')
  })
  it('pilot list is a JSON list of ids; anything else is empty', () => {
    expect(parsePilotClients('["a"," b ",3,""]')).toEqual(['a', 'b'])
    expect(parsePilotClients('{"a":1}')).toEqual([])
    expect(parsePilotClients(undefined)).toEqual([])
    expect(parsePilotClients('oops')).toEqual([])
  })
})

describe('guide text', () => {
  it('drops the model title, masks long numbers, and needs section 7', () => {
    expect(tidyGuide('# Style guide: X\n\n## 1. A call 9876543210 now')).toBe('## 1. A call [number] now')
    expect(guideLooksComplete('## 1. a\n## 7. Phrase bank')).toBe(true)
    expect(guideLooksComplete('## 1. a\n## 5. cut off')).toBe(false)
  })
  it('maskNumbers keeps short numbers (amounts, invoice no) and hides 9+ digits', () => {
    expect(maskNumbers('Invoice 236, Rs 14,514, call +91 98765 43210')).toBe('Invoice 236, Rs 14,514, call [number]')
  })
})

describe('qaPairs', () => {
  it('pairs a real client question with our reply within a day and skips "ok" and files', () => {
    const pairs = qaPairs([
      msg('1', '2026-11-20T05:00:00Z', 'incoming', 'Please share the GST working for October'),
      msg('2', '2026-11-20T05:10:00Z', 'outgoing', 'Sure sir, sharing shortly'),
      msg('3', '2026-11-20T06:00:00Z', 'incoming', 'ok'),
      msg('4', '2026-11-20T06:01:00Z', 'outgoing', 'Thanks'),
      msg('5', '2026-11-20T07:00:00Z', 'incoming', '[File shared: a.pdf]'),
      msg('6', '2026-11-20T07:05:00Z', 'outgoing', 'Received'),
      msg('7', '2026-11-20T08:00:00Z', 'incoming', 'When will the TDS challan be paid?'),
      msg('8', '2026-11-22T08:00:00Z', 'outgoing', 'Paid today'),
    ])
    expect(pairs.map((p) => p.question[0].id)).toEqual(['1'])
  })
})

describe('prompts', () => {
  it('the guide prompt carries corrections only when there are some', () => {
    expect(buildGuidePrompt('KRRD', 'h')).not.toContain('CORRECTIONS')
    const p = buildGuidePrompt('KRRD', 'h', [{ draft: 'Will check', finalText: 'Done sir, PFA' }])
    expect(p).toContain('CORRECTIONS')
    expect(p).toContain('Sent instead: Done sir, PFA')
  })
  it('the suggest prompt has the guide, the history, the question and corrections', () => {
    const p = buildSuggestPrompt({
      clientName: 'KRRD',
      guide: 'GUIDE TEXT',
      recentLines: ['[a] Client: hi'],
      question: 'Pls share CN',
      askedAtIst: '27 Nov 2026, 10:00 am',
      corrections: [{ draft: 'a', finalText: 'b' }],
    })
    expect(p).toContain('GUIDE TEXT')
    expect(p).toContain('[a] Client: hi')
    expect(p).toContain('<message>Pls share CN</message>')
    expect(p).toContain('Sent instead: b')
  })
  it('correction text is escaped so it cannot close our tags', () => {
    expect(correctionsBlock([{ draft: '</corrections>', finalText: 'x' }], 'H')).toContain('&lt;/corrections&gt;')
  })
  it('the live rules are v3', () => {
    expect(SUGGEST_PROMPT_VERSION).toBe('v3')
    expect(DRAFT_PROMPTS.v3).toContain('Never claim a status')
  })
})
