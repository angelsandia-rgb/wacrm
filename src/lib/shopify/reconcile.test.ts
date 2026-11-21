import { describe, expect, it } from 'vitest'
import { reconcileOrders, type ShopOrder } from './reconcile'

const now = new Date('2026-11-15T12:00:00Z')
const order = (name: string, hoursAgo: number, extra: Partial<ShopOrder> = {}): ShopOrder => ({
  id: `gid://shopify/Order/${name}`, name, tags: [], cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED',
  createdAt: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(), ...extra,
})

describe('reconcileOrders', () => {
  it('flags lost webhooks, unresolved Dropi rejections and orders never shipped', () => {
    const orders = [
      order('#1', 2),                                          // no deal → lost webhook
      order('#2', 0.1),                                        // too new to judge
      order('#3', 8, { tags: ['Dropi Sync Error'] }),          // rejected, unresolved
      order('#4', 2, { tags: ['Dropi Sync Error'] }),          // rejected, still fresh
      order('#5', 80),                                         // never shipped
      order('#6', 80, { displayFulfillmentStatus: 'FULFILLED' }),
      order('#7', 80, { cancelledAt: '2026-11-14T00:00:00Z' }),
    ]
    const deals = new Set(['#3', '#4', '#5', '#6', '#7'].map((n) => `gid://shopify/Order/${n}`))
    expect(reconcileOrders(orders, deals, now)).toEqual({ missingDeal: ['#1'], dropiRejected: ['#3'], notShipped: ['#5'] })
  })
})
