import { describe, expect, it } from 'vitest'
import { salesByAd } from './ad-sales'
import { extractWhatsAppAdReferral } from '@/lib/zernio/webhook-referral'

describe('salesByAd', () => {
  it('groups leads and sales per ad, best revenue first, ignoring non-ad referrals', () => {
    const rows = salesByAd(
      [
        { id: 'c1', referral: { source: 'ADS', ad_id: 'a1', ad_name: 'Luces solares', campaign_name: 'Navidad' } },
        { id: 'c2', referral: { source: 'ADS', ad_id: 'a1', ad_name: 'Luces solares', campaign_name: 'Navidad' } },
        { id: 'c3', referral: { source: 'ADS', ad_id: 'a2', ad_name: 'Licuadora' } },
        { id: 'c4', referral: { source: 'SHORTLINK' } },
        { id: 'c5', referral: null },
      ],
      [
        { contact_id: 'c1', status: 'open', value: 400, shopify_order_id: 'gid://shopify/Order/1' },
        { contact_id: 'c2', status: 'lost', value: 400, shopify_order_id: 'gid://shopify/Order/2' },
        { contact_id: 'c3', status: 'won', value: 249, shopify_order_id: null },
        { contact_id: 'c3', status: 'open', value: 999, shopify_order_id: null },
        { contact_id: 'c4', status: 'won', value: 5000, shopify_order_id: null },
      ],
    )
    expect(rows).toEqual([
      { key: 'a1', ad: 'Luces solares', campaign: 'Navidad', leads: 2, sales: 1, revenue: 400 },
      { key: 'a2', ad: 'Licuadora', campaign: null, leads: 1, sales: 1, revenue: 249 },
    ])
  })
})

describe('extractWhatsAppAdReferral', () => {
  it('reads Zernio CTWA metadata into the contacts.referral shape', () => {
    const r = extractWhatsAppAdReferral({
      referral: { ctwa_clid: 'clid1', source_id: '1200', headline: 'Luces que no gastan luz', source_type: 'ad' },
      ad: { adId: '1200', name: 'Luces - video 1', campaignId: 'c9', campaignName: 'Navidad', adSetId: 's1', adSetName: 'GT 25-45' },
    })
    expect(r).toMatchObject({
      source: 'ADS', channel: 'whatsapp', ad_id: '1200', ad_name: 'Luces - video 1', campaign_name: 'Navidad',
      adset_name: 'GT 25-45', headline: 'Luces que no gastan luz', ctwa_clid: 'clid1',
    })
  })
  it('is null for a message that did not come from an ad', () => {
    expect(extractWhatsAppAdReferral({ interactive: { id: 'x' } })).toBeNull()
    expect(extractWhatsAppAdReferral(null)).toBeNull()
  })
})
