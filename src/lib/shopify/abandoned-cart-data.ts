import { formatCurrency } from '@/lib/currency'
import { normalizeGtPhone } from './api'

export const CART_TEMPLATE_NAME = 'carrito_abandonado'
export const CART_WAIT_MS = 60 * 60_000
export const CART_MAX_AGE_MS = 24 * 60 * 60_000

export interface AbandonedCheckout {
  id: string
  updatedAt: string
  completedAt: string | null
  abandonedCheckoutUrl: string
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } }
  customer: { firstName: string | null; phone: string | null } | null
  shippingAddress: { firstName: string | null; phone: string | null } | null
  lineItems: { nodes: { title: string; quantity: number }[] }
}

export const CART_FIELDS = `id updatedAt completedAt abandonedCheckoutUrl totalPriceSet { shopMoney { amount currencyCode } }
  customer { firstName phone } shippingAddress { firstName phone } lineItems(first: 10) { nodes { title quantity } }`

export function dueCarts(carts: AbandonedCheckout[], now: Date): (AbandonedCheckout & { phone: string })[] {
  return carts.flatMap((c) => {
    const age = now.getTime() - Date.parse(c.updatedAt)
    const phone = normalizeGtPhone(c.shippingAddress?.phone || c.customer?.phone || '')
    return !c.completedAt && phone && age >= CART_WAIT_MS && age <= CART_MAX_AGE_MS ? [{ ...c, phone }] : []
  })
}

export function cartReminderText(c: AbandonedCheckout, storeName: string): string {
  const name = c.shippingAddress?.firstName || c.customer?.firstName || ''
  const items = c.lineItems.nodes.map((i) => `• ${i.quantity} x ${i.title}`).join('\n')
  const total = formatCurrency(Number(c.totalPriceSet.shopMoney.amount), c.totalPriceSet.shopMoney.currencyCode)
  return `¡Hola${name ? ` ${name}` : ''}! 😊 Vimos que dejó pendiente su pedido en ${storeName}:\n${items}\nTotal: ${total}.\n\n` +
    `Puede terminarlo aquí: ${c.abandonedCheckoutUrl}\nO si prefiere, se lo tomamos por aquí mismo. ¿Le ayudo con algo?`
}

export function cartTemplate(c: AbandonedCheckout) {
  const firstName = c.shippingAddress?.firstName || c.customer?.firstName || 'cliente'
  return { names: [CART_TEMPLATE_NAME], params: [firstName, c.lineItems.nodes.map((i) => `${i.quantity} x ${i.title}`).join(', '), c.abandonedCheckoutUrl] }
}
