import type { DmReferral } from '@/lib/messaging/dm-inbound'

/**
 * Best-effort ad / post referral extraction from a Zernio inbox webhook
 * payload. Zernio's public schema doesn't document a referral field
 * yet, so this probes every plausible location and returns null when
 * there's nothing — free when Zernio never forwards it, and it starts
 * capturing the moment they do (the caller also logs a hit so we
 * notice). Same `{ source, type, ad_id, ref }` shape Meta uses.
 */
export function extractZernioReferral(payload: unknown): DmReferral | null {
  const p = payload as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return null

  const get = (obj: unknown, ...path: string[]): unknown => {
    let cur: unknown = obj
    for (const key of path) {
      if (!cur || typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[key]
    }
    return cur
  }

  const candidates: unknown[] = [
    get(p, 'message', 'referral'),
    get(p, 'message', 'metadata', 'referral'),
    get(p, 'message', 'metadata'),
    get(p, 'conversation', 'referral'),
    get(p, 'conversation', 'metadata', 'referral'),
    get(p, 'referral'),
  ]

  for (const c of candidates) {
    if (
      c &&
      typeof c === 'object' &&
      (('source' in c) || ('ad_id' in c) || ('ref' in c) || ('type' in c))
    ) {
      return c as DmReferral
    }
  }
  return null
}

/**
 * Click-to-WhatsApp ad attribution from a Zernio `message.received`
 * (https://docs.zernio.com/platforms/whatsapp/ctwa): the first inbound
 * message after an ad click carries Meta's verbatim referral under
 * `metadata.referral` (`ctwa_clid`, `source_id`, `headline`…) and Zernio's
 * resolved ad under `metadata.ad` (ad / ad set / campaign names). Flattened
 * into the `contacts.referral` shape so IG/FB and WhatsApp report together.
 */
export function extractWhatsAppAdReferral(metadata: unknown): DmReferral | null {
  if (!metadata || typeof metadata !== 'object') return null
  const md = metadata as Record<string, unknown>
  const ref = (md.referral && typeof md.referral === 'object' ? md.referral : {}) as Record<string, unknown>
  const ad = (md.ad && typeof md.ad === 'object' ? md.ad : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const ctwaClid = str(ref.ctwa_clid) ?? str(md.ctwa_clid)
  const adId = str(ad.adId) ?? str(ref.source_id) ?? str(md.ctwa_source_id)
  if (!ctwaClid && !adId) return null
  const out: DmReferral = {
    source: 'ADS',
    channel: 'whatsapp',
    ad_id: adId,
    ad_name: str(ad.name),
    campaign_id: str(ad.campaignId),
    campaign_name: str(ad.campaignName),
    adset_id: str(ad.adSetId),
    adset_name: str(ad.adSetName),
    headline: str(ref.headline) ?? str(md.ctwa_headline),
    source_url: str(ref.source_url) ?? str(md.ctwa_source_url),
    ctwa_clid: ctwaClid,
    captured_at: new Date().toISOString(),
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as DmReferral
}
