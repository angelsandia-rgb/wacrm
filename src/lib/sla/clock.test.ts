import { describe, expect, it } from 'vitest'
import { dueStages, isNonCustomerTag, unansweredSince, waitingMinutes, type SlaMessage } from './clock'

const msg = (sender_type: string, content_text: string | null, created_at: string, content_type = 'text'): SlaMessage =>
  ({ sender_type, content_type, content_text, created_at })

describe('unansweredSince', () => {
  it('anchors on the first message of the trailing customer burst', () => {
    expect(unansweredSince([
      msg('customer', '¿Tienen para 5 personas?', '2026-11-24T14:05:00Z'),
      msg('customer', 'Hola', '2026-11-24T14:04:00Z'),
      msg('agent', 'Con gusto', '2026-11-24T13:00:00Z'),
    ])).toBe('2026-11-24T14:04:00Z')
  })
  it('is null once a teammate or the bot answered', () => {
    expect(unansweredSince([msg('bot', 'Claro', '2026-11-24T14:06:00Z'), msg('customer', 'Hola', '2026-11-24T14:05:00Z')])).toBeNull()
  })
  it('ignores the WhatsApp Business app auto-replies and internal notes', () => {
    expect(unansweredSince([
      msg('bot', 'nota', '2026-11-24T14:07:00Z', 'internal_note'),
      msg('agent', 'Gracias por comunicarse con Villa San Ricardo. ¿Cómo podemos ayudarle?', '2026-11-24T14:06:00Z'),
      msg('customer', 'Hola', '2026-11-24T14:05:00Z'),
    ])).toBe('2026-11-24T14:05:00Z')
  })
  it('does not start the clock on a plain thanks, but does on a voice note', () => {
    expect(unansweredSince([msg('customer', 'Muchas gracias', 'x'), msg('agent', 'Listo', 'y')])).toBeNull()
    expect(unansweredSince([msg('customer', null, '2026-11-24T14:05:00Z', 'audio')])).toBe('2026-11-24T14:05:00Z')
  })
})

describe('waitingMinutes (Guatemala, UTC-6, window 8–20)', () => {
  const TZ = 'America/Guatemala'
  it('counts plain minutes inside the window', () => {
    expect(waitingMinutes('2026-11-24T16:00:00Z', new Date('2026-11-24T16:35:00Z'), TZ, 8, 20)).toBe(35)
  })
  it('is null outside the window (21:00 local)', () => {
    expect(waitingMinutes('2026-11-25T02:00:00Z', new Date('2026-11-25T03:00:00Z'), TZ, 8, 20)).toBeNull()
  })
  it('a message from last night counts from 8:00', () => {
    // sent 22:00 local, now 8:12 local next day → 12 min
    expect(waitingMinutes('2026-11-25T04:00:00Z', new Date('2026-11-25T14:12:00Z'), TZ, 8, 20)).toBe(12)
  })
  it('equal hours = always on', () => {
    expect(waitingMinutes('2026-11-25T04:00:00Z', new Date('2026-11-25T05:00:00Z'), TZ, 0, 0)).toBe(60)
  })
})

describe('dueStages', () => {
  const cfg = { alert_minutes: 10, escalate_minutes: 30, ai_ack_minutes: 60, window_start_hour: 8, window_end_hour: 20 }
  it('fires each stage once, in order', () => {
    expect(dueStages(9, cfg, new Set())).toEqual([])
    expect(dueStages(12, cfg, new Set())).toEqual(['alert'])
    expect(dueStages(31, cfg, new Set(['alert']))).toEqual(['escalate'])
    expect(dueStages(65, cfg, new Set(['alert', 'escalate']))).toEqual(['ai_ack'])
  })
  it('no bot acknowledgement when it is off', () => {
    expect(dueStages(90, { ...cfg, ai_ack_minutes: null }, new Set(['alert', 'escalate']))).toEqual([])
  })
})

it('internal / staff / supplier contacts have no clock; Sin IA customers do', () => {
  expect(['Interno', 'PERSONAL', 'Proveedor'].every(isNonCustomerTag)).toBe(true)
  expect(isNonCustomerTag('Sin IA')).toBe(false)
})
