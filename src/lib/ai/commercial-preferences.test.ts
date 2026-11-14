import { describe, expect, it } from 'vitest'
import { contactMutesCommercial, detectCommercialOptOut, persistCommercialOptOut } from './commercial-preferences'

describe('explicit commercial opt-outs', () => {
  it.each(['STOP', 'No me escriban más', 'Por favor, no me manden más mensajes.', 'No quiero promociones', 'No deseo recibir más ofertas', 'Dejen de enviarme publicidad', 'Deme de baja', 'No promociones, solo el estado de mi pedido'])('detects %s', text => {
    expect(detectCommercialOptOut(text)).toBe(true)
  })
  it.each(['No quiero comprar ahora', 'Lo voy a pensar', 'No dejen de enviarme ofertas', 'No dejes de escribirme', '¿Cómo se dice "no me escriban más" en inglés?', 'Traduce no me escriban más al inglés', 'Mi hermano dijo no me escriban más', 'No me escriben mensajes con el número de guía', '¿Hay promociones?', 'Gracias'])('does not infer opt-out from %s', text => {
    expect(detectCommercialOptOut(text)).toBe(false)
  })
})

function database() {
  const tags = new Map<string, { id: string; account_id: string; user_id: string; name: string }>()
  const links = new Map<string, { contact_id: string; tag_id: string }>()
  const contacts = [{ id: 'ct', account_id: 'a', user_id: 'owner' }, { id: 'foreign', account_id: 'b', user_id: 'other' }]
  const writes: { table: string; payload: Record<string, string>; options: unknown }[] = []
  let fail = ''
  const db = { from(table: string) {
    const filters: Record<string, unknown> = {}
    let payload: Record<string, string> | undefined
    function result() {
      if (fail === table) return { data: null, error: { message: 'unavailable' } }
      if (payload) {
        if (table === 'tags' && !tags.has(payload.id)) tags.set(payload.id, payload as never)
        if (table === 'contact_tags') links.set(`${payload.contact_id}:${payload.tag_id}`, payload as never)
        return { data: null, error: null }
      }
      if (table === 'contacts') return { data: contacts.find(c => Object.entries(filters).every(([k, v]) => c[k as keyof typeof c] === v)) ?? null, error: null }
      if (table === 'tags') return { data: [...tags.values()].find(t => t.account_id === filters.account_id
        && (filters.id ? t.id === filters.id : t.name.toLowerCase() === String(filters.name).toLowerCase())) ?? null, error: null }
      return { data: [...links.values()].filter(l => l.contact_id === filters.contact_id).flatMap(l => {
        const t = tags.get(l.tag_id)
        return t?.account_id === filters['tags.account_id'] ? [{ tags: t }] : []
      }), error: null }
    }
    const c = {
      select: () => c, order: () => c, limit: () => c,
      eq: (key: string, value: unknown) => { filters[key] = value; return c },
      ilike: (key: string, value: unknown) => { filters[key] = value; return c },
      upsert: (value: Record<string, string>, options: unknown) => { payload = value; writes.push({ table, payload: value, options }); return c },
      maybeSingle: async () => result(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    }
    return c
  } }
  return { db: db as never, tags, links, writes, fail: (table: string) => { fail = table } }
}

describe('persistent account-scoped marketing preference', () => {
  it('saves once under concurrent requests without clearing existing tags', async () => {
    const s = database()
    s.tags.set('vip', { id: 'vip', account_id: 'a', user_id: 'owner', name: 'VIP' })
    s.links.set('ct:vip', { contact_id: 'ct', tag_id: 'vip' })
    await Promise.all([persistCommercialOptOut(s.db, 'a', 'ct'), persistCommercialOptOut(s.db, 'a', 'ct')])
    expect(s.tags.size).toBe(2)
    expect(s.links.size).toBe(2)
    expect(s.links.has('ct:vip')).toBe(true)
    expect(await contactMutesCommercial(s.db, 'a', 'ct')).toBe(true)
    expect(s.writes.every(w => w.options && typeof w.options === 'object' && 'ignoreDuplicates' in w.options)).toBe(true)
  })
  it('reuses an existing account tag case-insensitively', async () => {
    const s = database()
    s.tags.set('existing', { id: 'existing', account_id: 'a', user_id: 'owner', name: 'SIN PROMOCIONES' })
    await persistCommercialOptOut(s.db, 'a', 'ct')
    expect(s.tags.size).toBe(1)
    expect(s.links.has('ct:existing')).toBe(true)
    expect(s.writes.some(w => w.table === 'tags')).toBe(false)
  })
  it('rejects cross-account persistence and does not change any tags', async () => {
    const s = database()
    await expect(persistCommercialOptOut(s.db, 'a', 'foreign')).rejects.toThrow('ownership')
    expect(s.writes).toEqual([])
    expect(await contactMutesCommercial(s.db, 'a', 'foreign')).toBe(true)
  })
  it('does not treat another account tag as the preference', async () => {
    const s = database()
    s.tags.set('other', { id: 'other', account_id: 'b', user_id: 'other', name: 'Sin promociones' })
    s.links.set('ct:other', { contact_id: 'ct', tag_id: 'other' })
    expect(await contactMutesCommercial(s.db, 'a', 'ct')).toBe(false)
  })
  it.each(['contacts', 'tags', 'contact_tags'])('never acknowledges a successful write if %s fails', async table => {
    const s = database(); s.fail(table)
    await expect(persistCommercialOptOut(s.db, 'a', 'ct')).rejects.toThrow()
  })
  it('fails closed when reading a saved preference is unavailable', async () => {
    const s = database(); s.fail('contact_tags')
    await expect(contactMutesCommercial(s.db, 'a', 'ct')).rejects.toThrow('Cannot read commercial preference')
  })
})
