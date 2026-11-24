import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildPurchaseEvent } from './capi'

const sha = (v: string) => createHash('sha256').update(v).digest('hex')

describe('buildPurchaseEvent', () => {
  it('hashes normalized PII and keys the event on the Shopify order', () => {
    const e = buildPurchaseEvent({
      id: 'gid://shopify/Order/6123', name: '#1015', total: 400, currency: 'GTQ',
      phone: '+502 5485-2732', firstName: 'Ángel', lastName: 'Durán Simón', city: 'Villa Canales', itemCount: 1,
    }, 1_800_000_000)
    expect(e.event_id).toBe('chat-sandia-6123')
    expect(e.action_source).toBe('chat')
    expect(e.user_data.ph).toEqual([sha('50254852732')])
    expect(e.user_data.fn).toEqual([sha('angel')])
    expect(e.user_data.ln).toEqual([sha('duransimon')])
    expect(e.user_data.ct).toEqual([sha('villacanales')])
    expect(e.custom_data).toEqual({ currency: 'GTQ', value: 400, order_id: '#1015', num_items: 1 })
  })

  it('leaves out empty fields instead of hashing an empty string', () => {
    const e = buildPurchaseEvent({ id: 'gid://shopify/Order/1', name: '#1', total: 1, currency: 'GTQ', phone: '+50211112222', itemCount: 1 }, 1)
    expect(e.user_data.fn).toBeUndefined()
    expect(e.user_data.ct).toBeUndefined()
  })
})
