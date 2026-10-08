import { describe, it, expect } from 'vitest'
import {
  classifyTrailingOutbound,
  hasTeammateReply,
  trailingCustomerTurns,
  type OutboundRow,
} from './human-reply'

const row = (over: Partial<OutboundRow>): OutboundRow => ({
  sender_type: 'agent',
  content_type: 'text',
  content_text: 'hola',
  created_at: '2026-09-26T10:00:00.000Z',
  ...over,
})

describe('classifyTrailingOutbound', () => {
  it('is unanswered when nothing was sent after the customer', () => {
    expect(classifyTrailingOutbound([])).toEqual({ kind: 'unanswered' })
  })

  it('ignores internal notes', () => {
    expect(classifyTrailingOutbound([row({ sender_type: 'bot', content_type: 'internal_note' })])).toEqual({
      kind: 'unanswered',
    })
  })

  it('any platform (bot) row means the bot already answered', () => {
    expect(classifyTrailingOutbound([row({}), row({ sender_type: 'bot' })])).toEqual({ kind: 'bot_answered' })
  })

  it('collects the human texts when only teammates answered', () => {
    expect(classifyTrailingOutbound([row({ content_text: 'Hola' }), row({ content_text: ' Sí hay ' })])).toEqual({
      kind: 'human_answered',
      humanTexts: ['Hola', 'Sí hay'],
    })
  })

  it('a human file/photo without text still counts as a human answer', () => {
    expect(classifyTrailingOutbound([row({ content_type: 'image', content_text: null })])).toEqual({
      kind: 'human_answered',
      humanTexts: ['(El asesor envió un archivo o imagen.)'],
    })
  })
})

describe('transcript helpers', () => {
  const msgs = [
    { role: 'assistant' as const, content: 'Bienvenido' },
    { role: 'user' as const, content: 'a' },
    { role: 'user' as const, content: 'b' },
    { role: 'assistant' as const, content: 'humano' },
  ]

  it('returns the customer turns at the end of the transcript', () => {
    expect(trailingCustomerTurns(msgs.slice(0, 3))).toEqual(['a', 'b'])
  })
})

describe('hasTeammateReply', () => {
  const r = (sender_type: string, created_at: string) => ({ sender_type, created_at })
  it('WhatsApp Business auto-greetings seconds after the customer are not a teammate (VSR, 2026-10-07)', () => {
    expect(
      hasTeammateReply([
        r('customer', '2026-10-07T03:09:45.994Z'),
        r('agent', '2026-10-07T03:09:51.023Z'),
        r('agent', '2026-10-07T03:09:51.291Z'),
      ]),
    ).toBe(false)
  })
  it('a person answering the customer takes the thread over', () => {
    expect(hasTeammateReply([r('customer', '2026-10-07T18:24:01Z'), r('agent', '2026-10-07T18:26:43Z')])).toBe(true)
  })
  it('a template the team sent before the customer ever wrote does not count', () => {
    expect(hasTeammateReply([r('agent', '2026-10-07T10:00:00Z'), r('customer', '2026-10-07T11:00:00Z')])).toBe(false)
  })
})
