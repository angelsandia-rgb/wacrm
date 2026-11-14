import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { catalogQueryFromMessages, loadCatalogContext } from './catalog-context'

function makeDb(
  products: { id?: string; name: string; price: number; description: string | null }[],
  defaultCurrency: string | undefined = 'USD',
  opts: { vertical?: string; rates?: unknown[]; maxGuests?: Record<string, number> } = {},
) {
  const db = {
    from: (table: string) => {
      if (table === 'products') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: (limit: number) => Promise.resolve({ data: products.slice(0, limit), error: null }),
          // capacity read (migration 160)
          in: () =>
            Promise.resolve({
              data: Object.entries(opts.maxGuests ?? {}).map(([id, max_guests]) => ({ id, max_guests })),
              error: null,
            }),
        }
        return chain
      }
      if (table === 'product_rates') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => Promise.resolve({ data: opts.rates ?? [], error: null }),
        }
        return chain
      }
      // accounts
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  default_currency: defaultCurrency,
                  industry_vertical: opts.vertical ?? 'generic',
                },
                error: null,
              }),
          }),
        }),
      }
    },
  }
  return db as unknown as SupabaseClient
}

describe('loadCatalogContext', () => {
  it('returns null when the account has no active products', async () => {
    const res = await loadCatalogContext(makeDb([]), 'acct-1')
    expect(res).toBeNull()
  })

  it('keeps every product available to the assistant in a 32-product store', async () => {
    const products = Array.from({ length: 32 }, (_, index) => ({
      name: `Producto ${String(index + 1).padStart(2, '0')}`,
      price: index + 100,
      description: null,
    }))
    const res = await loadCatalogContext(makeDb(products, 'GTQ'), 'acct-1')
    expect(res).toHaveLength(32)
    expect(res?.at(-1)).toContain('Producto 32')
  })

  it('formats each product with its currency-formatted price', async () => {
    // Assert on structure, not the localized currency symbol: Intl
    // renders GTQ as "Q150" under an es-* runtime locale but "GTQ 150"
    // under en-* (the CI runner), and formatCurrency passes `undefined`
    // for the locale. Same reason the USD test below only checks "(".
    const res = await loadCatalogContext(
      makeDb([{ name: 'Camisa', price: 150, description: null }], 'GTQ'),
      'acct-1',
    )
    expect(res).toHaveLength(1)
    expect(res![0]).toMatch(/^- Camisa \(.*150\)/)
  })

  it('appends a short description when present', async () => {
    const res = await loadCatalogContext(
      makeDb([{ name: 'Camisa', price: 150, description: 'Algodón 100%' }], 'GTQ'),
      'acct-1',
    )
    expect(res).toHaveLength(1)
    expect(res![0]).toContain('— Algodón 100%')
  })

  it('truncates a long description instead of blowing up the prompt', async () => {
    const longDesc = 'x'.repeat(200)
    const res = await loadCatalogContext(
      makeDb([{ name: 'Camisa', price: 150, description: longDesc }], 'GTQ'),
      'acct-1',
    )
    expect(res![0].length).toBeLessThan(longDesc.length)
    expect(res![0]).toContain('…')
  })

  it('shows a room rate structure for a hotel account', async () => {
    const res = await loadCatalogContext(
      makeDb(
        [{ id: 'r1', name: 'Hab 101', price: 0, description: 'Vista jardín' }],
        'GTQ',
        {
          vertical: 'hotel',
          rates: [
            { product_id: 'r1', day_of_week: 'mon', occupancy: 'standard', price: 800, date_from: null, date_to: null },
            { product_id: 'r1', day_of_week: 'tue', occupancy: 'standard', price: 800, date_from: null, date_to: null },
            { product_id: 'r1', day_of_week: 'fri', occupancy: 'standard', price: 1200, date_from: null, date_to: null },
            { product_id: 'r1', day_of_week: 'mon', occupancy: 'couple', price: 950, date_from: null, date_to: null },
            { product_id: 'r1', day_of_week: 'fri', occupancy: 'group', price: 1600, date_from: null, date_to: null },
          ],
        },
      ),
      'acct-1',
    )
    expect(res).toHaveLength(1)
    expect(res![0]).toContain('Hab 101:')
    // comma/space in "1,200" varies by runtime locale — match loosely
    expect(res![0]).toMatch(/Lun–Mar .*800/)
    expect(res![0]).toMatch(/Vie .*1.?200/)
    expect(res![0]).toMatch(/pareja Lun .*950/)
    expect(res![0]).toMatch(/grupo Vie .*1.?600/)
    expect(res![0]).toContain('— Vista jardín')
  })

  it('lists each season separately, with its dates and guest tiers', async () => {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
    const season = (occupancy: string, price: number, date_from: string, date_to: string) =>
      days.map((day_of_week) => ({ product_id: 'r1', day_of_week, occupancy, price, date_from, date_to }))
    const res = await loadCatalogContext(
      makeDb([{ id: 'r1', name: 'Suite Premium', price: 0, description: null }], 'GTQ', {
        vertical: 'hotel',
        rates: [
          ...season('standard', 450, '2026-12-24', '2027-01-01'),
          ...season('couple', 870, '2026-12-24', '2027-01-01'),
          ...season('couple', 870, '2027-03-21', '2027-03-27'),
        ],
      }),
      'acct-1',
    )
    expect(res![0]).toMatch(/temporada 24\/12\/2026–01\/01\/2027: Lun–Dom .*450 · pareja Lun–Dom .*870/)
    expect(res![0]).toMatch(/temporada 21\/03\/2027–27\/03\/2027: pareja Lun–Dom .*870/)
  })

  it('a hotel product with no rates still shows its base price', async () => {
    const res = await loadCatalogContext(
      makeDb([{ id: 's1', name: 'Masaje', price: 250, description: null }], 'GTQ', {
        vertical: 'hotel',
        rates: [],
      }),
      'acct-1',
    )
    expect(res![0]).toMatch(/^- Masaje \(.*250\)/)
  })

  it('falls back to USD when the account has no default_currency', async () => {
    const res = await loadCatalogContext(
      makeDb([{ name: 'Widget', price: 10, description: null }], undefined),
      'acct-1',
    )
    expect(res).toHaveLength(1)
    expect(res![0]).toContain('- Widget (')
    expect(res![0]).toContain('10')
  })
})

type SearchProduct = { id: string; name: string; price: number; description: string | null; account_id: string; is_active: boolean }
type ProductQuery = { filters: Record<string, unknown>; nameFilter: string | null; limit: number }

function makeSearchDb(products: SearchProduct[], queries: ProductQuery[], searchFails = false) {
  return {
    from(table: string) {
      if (table === 'accounts') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { default_currency: 'GTQ', industry_vertical: 'dropshipping' }, error: null }) }) }),
      }
      const filters: Record<string, unknown> = {}
      let nameFilter: string | null = null
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { filters[key] = value; return chain },
        or: (filter: string) => { nameFilter = filter; return chain },
        order: () => chain,
        limit: async (limit: number) => {
          queries.push({ filters: { ...filters }, nameFilter, limit })
          if (nameFilter && searchFails) return { data: null, error: { message: 'Search unavailable' } }
          const patterns = nameFilter ? [...nameFilter.matchAll(/name\.ilike\.%([\p{L}\p{N}_]+)%/gu)]
            .map((match) => new RegExp(match[1].replace(/_/g, '.'), 'iu')) : []
          const data = products.filter((p) => Object.entries(filters).every(([key, value]) => p[key as keyof SearchProduct] === value))
            .filter((p) => !patterns.length || (nameFilter?.startsWith('and(') ? patterns.every((r) => r.test(p.name)) : patterns.some((r) => r.test(p.name))))
            .sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit)
          return { data, error: null }
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
}

const largeCatalog = (): SearchProduct[] => [
  ...Array.from({ length: 55 }, (_, i) => ({ id: `p-${i}`, name: `Artículo ${String(i).padStart(2, '0')}`, price: 100 + i, description: null, account_id: 'acct-1', is_active: true })),
  { id: 'sofa', name: 'Sofá Inflable', price: 400, description: 'Se desinfla para guardarlo.', account_id: 'acct-1', is_active: true },
]

describe('loadCatalogContext — bounded product-name retrieval', () => {
  it('retains a product beyond the first 50 when the buyer confirms its recent summary', async () => {
    const messages = [
      { role: 'user', content: 'Quiero un Sofá Inflable' },
      { role: 'assistant', content: 'Resumen: Sofá Inflable, total Q400, pago contra entrega. ¿Confirma?' },
      { role: 'user', content: 'Sí, lo quiero' },
    ]
    const query = catalogQueryFromMessages(messages)
    const lines = await loadCatalogContext(makeSearchDb(largeCatalog(), []), 'acct-1', query)
    expect(query.startsWith('Sí, lo quiero')).toBe(true)
    expect(lines?.[0]).toContain('Sofá Inflable')
    expect(lines).toHaveLength(50)
  })

  it('prioritizes a newly named product over the previous product in recent history', async () => {
    const products = largeCatalog()
    products.push({ id: 'organizer', name: 'Organizador Plegable', price: 189, description: 'Para ordenar zapatos.', account_id: 'acct-1', is_active: true })
    const query = catalogQueryFromMessages([
      { role: 'user', content: 'Sofá Inflable' },
      { role: 'assistant', content: 'El Sofá Inflable cuesta Q400.' },
      { role: 'user', content: 'Mejor quiero el Organizador Plegable' },
    ])
    const lines = await loadCatalogContext(makeSearchDb(products, []), 'acct-1', query)
    expect(lines?.[0]).toContain('Organizador Plegable')
  })

  it('bounds recent context and omits unrelated older turns', () => {
    const query = catalogQueryFromMessages([
      { role: 'user', content: 'Producto antiguo fuera de contexto' },
      ...Array.from({ length: 4 }, (_, i) => ({ role: 'user', content: `Producto ${i} ${'x'.repeat(900)}` })),
    ])
    expect(query).not.toContain('antiguo')
    expect(query).toHaveLength(2000)
    expect(query.startsWith('Producto 3')).toBe(true)
  })

  it('includes a named product beyond the initial 50 while keeping the final prompt bounded and deduplicated', async () => {
    const products = largeCatalog()
    const queries: ProductQuery[] = []
    const lines = await loadCatalogContext(makeSearchDb(products, queries), 'acct-1', 'Quiero saber el precio del sofa inflable')
    expect(lines).toHaveLength(50)
    expect(lines?.[0]).toContain('Sofá Inflable')
    expect(lines?.filter((line) => line.includes('Sofá Inflable'))).toHaveLength(1)
    expect(queries).toHaveLength(2)
    expect(queries.every((q) => q.limit === 50)).toBe(true)
  })

  it('keeps both base and relevant searches scoped to the account and active products', async () => {
    const products = largeCatalog()
    products.push(
      { ...products.at(-1)!, id: 'other-account', price: 999, account_id: 'acct-2' },
      { ...products.at(-1)!, id: 'inactive', price: 888, is_active: false },
    )
    const queries: ProductQuery[] = []
    const lines = await loadCatalogContext(makeSearchDb(products, queries), 'acct-1', 'Sofá inflable')
    expect(lines?.filter((line) => line.includes('Sofá Inflable'))).toHaveLength(1)
    expect(lines?.some((line) => /999|888/.test(line))).toBe(false)
    expect(queries.every((q) => q.filters.account_id === 'acct-1' && q.filters.is_active === true)).toBe(true)
  })

  it('prefers the complete named item over many products sharing only one word', async () => {
    const products = largeCatalog()
    products.push(...Array.from({ length: 60 }, (_, i) => ({ ...products.at(-1)!, id: `other-sofa-${i}`, name: `A Sofá modelo ${i}` })))
    const lines = await loadCatalogContext(makeSearchDb(products, []), 'acct-1', 'Quiero el sofa inflable')
    expect(lines?.[0]).toContain('Sofá Inflable')
  })

  it('removes user filter syntax and wildcards and bounds search tokens', async () => {
    const queries: ProductQuery[] = []
    await loadCatalogContext(makeSearchDb(largeCatalog(), queries), 'acct-1', 'Sofá %_),account_id.eq.acct2,is_active.eq.false,*"\n uno dos tres cuatro cinco seis siete ocho nueve diez')
    const searches = queries.filter((q) => q.nameFilter)
    expect(searches.length).toBeGreaterThan(0)
    for (const search of searches) {
      expect(search.nameFilter).not.toContain('account_id.eq')
      expect(search.nameFilter).not.toContain('is_active.eq')
      expect(search.nameFilter).not.toContain('*')
      expect([...search.nameFilter!.matchAll(/name\.ilike/g)]).toHaveLength(8)
      expect(search.nameFilter).toMatch(/^(?:and\()?name\.ilike\.%[\p{L}\p{N}_]+%(?:,name\.ilike\.%[\p{L}\p{N}_]+%)*(?:\))?$/u)
    }
  })

  it('does not expand a greeting or punctuation-only input into a wildcard search', async () => {
    const queries: ProductQuery[] = []
    const lines = await loadCatalogContext(makeSearchDb(largeCatalog(), queries), 'acct-1', 'Hola, ¿precio? %_*(),')
    expect(lines).toHaveLength(50)
    expect(queries).toHaveLength(1)
  })

  it('retains the base catalog if relevant-name retrieval fails', async () => {
    const queries: ProductQuery[] = []
    const lines = await loadCatalogContext(makeSearchDb(largeCatalog(), queries, true), 'acct-1', 'Sofá inflable')
    expect(lines).toHaveLength(50)
    expect(lines?.[0]).toContain('Artículo')
  })

  it('shows up to 300 description characters for commerce, retaining the generic and hotel bounds', async () => {
    const description = `${'Detalle '.repeat(18)}BENEFICIO_VERIFICADO ${'x'.repeat(200)}`
    const commerce = await loadCatalogContext(makeDb([{ name: 'Producto', price: 100, description }], 'GTQ', { vertical: 'dropshipping' }), 'acct-1')
    expect(commerce?.[0]).toContain('BENEFICIO_VERIFICADO')
    expect(commerce?.[0].split(' — ')[1]).toHaveLength(300)
    const generic = await loadCatalogContext(makeDb([{ name: 'Producto', price: 100, description }]), 'acct-1')
    expect(generic?.[0].split(' — ')[1]).toHaveLength(80)
    const hotel = await loadCatalogContext(makeDb([{ name: 'Habitación', price: 100, description: `${'x'.repeat(900)}RESTRICCION_REAL` }], 'GTQ', { vertical: 'hotel' }), 'acct-1')
    expect(hotel?.[0]).toContain('RESTRICCION_REAL')
    expect(hotel?.[0]).not.toContain('…')
  })
})

describe('loadCatalogContext — room capacity and child rate (migration 160)', () => {
  it('shows the capacity and the child rate so the model asks adults/children', async () => {
    const db = makeDb([{ id: 'p1', name: 'Junior Suite Familiar', price: 1160, description: null }], 'GTQ', {
      vertical: 'hotel',
      rates: [
        { product_id: 'p1', day_of_week: 'thu', occupancy: 'quad', price: 1160, date_from: null, date_to: null },
        { product_id: 'p1', day_of_week: 'thu', occupancy: 'child', price: 175, date_from: null, date_to: null },
      ],
      maxGuests: { p1: 5 },
    })
    const lines = await loadCatalogContext(db, 'acct')
    expect(lines?.[0]).toContain('niño 6–12 años (c/u)')
    expect(lines?.[0]).toContain('capacidad máx. 5 personas (adultos + niños)')
  })
})


it('keeps hotel restrictions beyond the old 80-character cutoff and hides disputed season amounts', async () => {
 const rates = [
  { product_id: 'r1', day_of_week: 'sun', occupancy: 'couple', price: 600, date_from: null, date_to: null },
  { product_id: 'r1', day_of_week: 'sun', occupancy: 'couple', price: 425, date_from: '2026-12-21', date_to: '2027-01-03' },
 ]
 const result = await loadCatalogContext(makeDb([{ id: 'r1', name: 'Junior Suite Familiar', price: 600, description: 'Habitacion familiar. '.repeat(6) + 'Desayuno incluido para los ni\u00f1os. Cama adicional solo en Junior. Tarifas de temporada alta pendientes de confirmacion del hotel.' }], 'GTQ', { vertical: 'hotel', rates }), 'acct-1')
 expect(result?.[0]).toContain('Desayuno incluido')
 expect(result?.[0]).toContain('Cama adicional')
 expect(result?.[0]).not.toContain('425')
 expect(result?.[0]).toContain('TEMPORADA ALTA: precio pendiente')
})
