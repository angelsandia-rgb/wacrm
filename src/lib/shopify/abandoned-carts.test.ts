import { describe, expect, it } from 'vitest'
import { cartReminderText, dueCarts, type AbandonedCheckout } from './abandoned-carts'

const now = new Date('2026-11-13T18:00:00Z')
const cart = (over: Partial<AbandonedCheckout> = {}): AbandonedCheckout => ({
  id: 'gid://shopify/AbandonedCheckout/1',
  updatedAt: new Date(now.getTime() - 2 * 3600_000).toISOString(),
  completedAt: null,
  abandonedCheckoutUrl: 'https://casaceibagt.myshopify.com/checkouts/x/recover',
  totalPriceSet: { shopMoney: { amount: '300.00', currencyCode: 'GTQ' } },
  customer: null,
  shippingAddress: { firstName: 'Ana', phone: '5485 2732' },
  lineItems: { nodes: [{ title: 'Retrovisor', quantity: 1 }] },
  ...over,
})

describe('dueCarts', () => {
  it('reminds a cart with a phone an hour to a day after it stopped', () => {
    expect(dueCarts([cart()], now).map((c) => c.phone)).toEqual(['+50254852732'])
  })
  it('skips completed, too fresh, too old and phoneless carts', () => {
    const at = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString()
    expect(dueCarts([
      cart({ completedAt: at(1) }),
      cart({ updatedAt: at(0.5) }),
      cart({ updatedAt: at(25) }),
      cart({ shippingAddress: { firstName: 'Ana', phone: null } }),
    ], now)).toEqual([])
  })
})

describe('cartReminderText', () => {
  it('lists the cart, total and recovery link', () => {
    expect(cartReminderText(cart(), 'Casa Ceiba')).toBe(
      '¡Hola Ana! 😊 Vimos que dejó pendiente su pedido en Casa Ceiba:\n• 1 x Retrovisor\nTotal: Q300.\n\n' +
      'Puede terminarlo aquí: https://casaceibagt.myshopify.com/checkouts/x/recover\nO si prefiere, se lo tomamos por aquí mismo. ¿Le ayudo con algo?',
    )
  })
})
