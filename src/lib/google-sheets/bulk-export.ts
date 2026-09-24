import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

// ============================================================
// Phase 2 — on-demand "export this table to Sheets now". Reads the
// account's current rows for one entity (RLS-scoped client from the
// route) and returns { tab, header, rows } for `clearAndWrite`.
//
// Deliberately a fixed column set per entity (not user-configurable
// yet) and capped — a report, not a backup. Reads are paged past
// PostgREST's 1000-row cap (a plain `.limit(5001)` silently stopped at
// 1000) and a failed read throws instead of writing an empty sheet.
// ============================================================

const EXPORTABLE_ENTITIES = ['contacts', 'deals', 'quotes', 'quote_items', 'funnel', 'products'] as const
export type ExportEntity = (typeof EXPORTABLE_ENTITIES)[number]

export const MAX_EXPORT_ROWS = 5000
/** Rows read per entity before sorting/capping — far above the export
 *  cap so the newest rows are always the ones kept. */
const MAX_READ_ROWS = 100_000

type Cell = string | number | null
type Row = { id: string } & Record<string, unknown>

export interface ExportResult {
  tab: string
  header: string[]
  rows: Cell[][]
  rowCount: number
  truncated: boolean
}

export function isExportEntity(v: unknown): v is ExportEntity {
  return typeof v === 'string' && (EXPORTABLE_ENTITIES as readonly string[]).includes(v)
}

export async function exportEntity(
  db: SupabaseClient,
  accountId: string,
  entity: ExportEntity,
): Promise<ExportResult> {
  switch (entity) {
    case 'contacts':
      return exportContacts(db, accountId)
    case 'deals':
      return exportDeals(db, accountId)
    case 'quotes':
      return exportQuotes(db, accountId)
    case 'quote_items':
      return exportQuoteItems(db, accountId)
    case 'funnel':
      return exportFunnel(db, accountId)
    case 'products':
      return exportProducts(db, accountId)
  }
}

function pack(tab: string, header: string[], data: Cell[][]): ExportResult {
  const truncated = data.length > MAX_EXPORT_ROWS
  const rows = truncated ? data.slice(0, MAX_EXPORT_ROWS) : data
  return { tab, header, rows: [header, ...rows], rowCount: rows.length, truncated }
}

/** Every row of `table` for the account (paged), `select` must include `id`. */
function readAll(db: SupabaseClient, accountId: string, table: string, select: string): Promise<Row[]> {
  return fetchAllRows<Row>(() => db.from(table).select(select).eq('account_id', accountId), {
    label: `sheets export ${table}`,
    maxRows: MAX_READ_ROWS,
  })
}

const newestFirst = (a: Row, b: Row) =>
  String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** user_id → display name for the account's members (salesperson column). */
async function memberNames(db: SupabaseClient, accountId: string): Promise<Map<string, string>> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id, full_name, email')
    .eq('account_id', accountId)
  if (error) throw error
  return new Map(
    ((data ?? []) as { user_id: string; full_name: string | null; email: string | null }[]).map((p) => [
      p.user_id,
      p.full_name || p.email || '',
    ]),
  )
}

async function exportContacts(db: SupabaseClient, accountId: string): Promise<ExportResult> {
  const contacts = (await readAll(db, accountId, 'contacts', 'id, name, phone, email, company, lead_temperature, created_at')).sort(newestFirst)
  const rows = contacts.map((c) => [
    str(c.name),
    str(c.phone),
    str(c.email),
    str(c.company),
    str(c.lead_temperature),
    str(c.created_at),
  ])
  return pack('Export Contactos', ['Nombre', 'Teléfono', 'Correo', 'Empresa', 'Temperatura', 'Creado'], rows)
}

async function exportDeals(db: SupabaseClient, accountId: string): Promise<ExportResult> {
  const [deals, names] = await Promise.all([
    readAll(
      db,
      accountId,
      'deals',
      'id, title, value, currency, status, won_at, created_at, assigned_to, user_id, contacts(name, phone), pipeline_stages(name)',
    ),
    memberNames(db, accountId),
  ])
  const rows = deals.sort(newestFirst).map((d) => {
    const contact = (d.contacts ?? {}) as { name?: string; phone?: string }
    const stage = (d.pipeline_stages ?? {}) as { name?: string }
    return [
      str(d.title),
      num(d.value),
      str(d.currency),
      stage.name ?? '',
      str(d.status),
      str(d.won_at),
      contact.name ?? '',
      contact.phone ?? '',
      names.get(str(d.assigned_to) || str(d.user_id)) ?? '',
      str(d.created_at),
    ]
  })
  return pack(
    'Export Negociaciones',
    ['Negociación', 'Monto', 'Moneda', 'Etapa', 'Estado', 'Ganada el', 'Cliente', 'Teléfono', 'Vendedor', 'Creado'],
    rows,
  )
}

async function exportQuotes(db: SupabaseClient, accountId: string): Promise<ExportResult> {
  const [quotes, names] = await Promise.all([
    readAll(
      db,
      accountId,
      'quotes',
      'id, subtotal, total, currency, status, customer_nit, created_at, user_id, contacts(name, phone)',
    ),
    memberNames(db, accountId),
  ])
  const rows = quotes.sort(newestFirst).map((q) => {
    const contact = (q.contacts ?? {}) as { name?: string; phone?: string }
    return [
      contact.name ?? '',
      contact.phone ?? '',
      str(q.customer_nit),
      num(q.subtotal),
      num(q.total),
      str(q.currency),
      str(q.status),
      names.get(str(q.user_id)) ?? '',
      str(q.created_at),
    ]
  })
  return pack(
    'Export Cotizaciones',
    ['Cliente', 'Teléfono', 'NIT', 'Subtotal', 'Total', 'Moneda', 'Estado', 'Vendedor', 'Creado'],
    rows,
  )
}

/** One row per quoted line — the basis for revenue by product. */
async function exportQuoteItems(db: SupabaseClient, accountId: string): Promise<ExportResult> {
  const [items, quotes, names] = await Promise.all([
    readAll(db, accountId, 'quote_items', 'id, quote_id, product_id, description, unit_price, quantity, line_total, position, products(name)'),
    readAll(db, accountId, 'quotes', 'id, status, currency, created_at, user_id, contacts(name, phone)'),
    memberNames(db, accountId),
  ])
  const quoteById = new Map(quotes.map((q) => [q.id, q]))
  const rows = items
    .map((it) => ({ it, q: quoteById.get(str(it.quote_id)) }))
    .filter((x): x is { it: Row; q: Row } => Boolean(x.q))
    .sort((a, b) => newestFirst(a.q, b.q) || num(a.it.position) - num(b.it.position))
    .map(({ it, q }) => {
      const contact = (q.contacts ?? {}) as { name?: string; phone?: string }
      const product = (it.products ?? {}) as { name?: string }
      return [
        str(q.created_at),
        contact.name ?? '',
        contact.phone ?? '',
        // Catalog name when the line points at a product; otherwise the
        // free-text description the quote was built with.
        product.name || str(it.description),
        str(it.description),
        num(it.quantity),
        num(it.unit_price),
        num(it.line_total),
        str(q.currency),
        str(q.status),
        names.get(str(q.user_id)) ?? '',
        q.id,
      ]
    })
  return pack(
    'Export Cotización ítems',
    ['Fecha', 'Cliente', 'Teléfono', 'Producto', 'Descripción', 'Cantidad', 'Precio unit.', 'Total línea', 'Moneda', 'Estado cotización', 'Vendedor', 'Cotización ID'],
    rows,
  )
}

const DAY_MS = 86_400_000

/**
 * One row per contact across the whole funnel: conversations → quotes →
 * deals, with the furthest stage reached. The backbone for conversion
 * pivots in the sheet.
 */
async function exportFunnel(db: SupabaseClient, accountId: string): Promise<ExportResult> {
  const [contacts, conversations, quotes, deals, names] = await Promise.all([
    readAll(db, accountId, 'contacts', 'id, name, phone, lead_temperature, created_at'),
    readAll(db, accountId, 'conversations', 'id, contact_id, channel, assigned_agent_id, last_message_at, created_at'),
    readAll(db, accountId, 'quotes', 'id, contact_id, total, currency, created_at'),
    readAll(db, accountId, 'deals', 'id, contact_id, title, value, currency, status, assigned_to, created_at, updated_at, pipeline_stages(name)'),
    memberNames(db, accountId),
  ])

  const group = (rows: Row[]) => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      const k = str(r.contact_id)
      if (!k) continue
      const list = m.get(k) ?? []
      list.push(r)
      m.set(k, list)
    }
    return m
  }
  const convsBy = group(conversations)
  const quotesBy = group(quotes)
  const dealsBy = group(deals)
  const now = Date.now()

  const rows = contacts.sort(newestFirst).map((c) => {
    const convs = (convsBy.get(c.id) ?? []).sort(newestFirst)
    const cQuotes = quotesBy.get(c.id) ?? []
    const cDeals = (dealsBy.get(c.id) ?? []).sort(newestFirst)
    // Current deal: the newest open one, else the newest of any status.
    const deal = cDeals.find((d) => d.status === 'open') ?? cDeals[0]
    const stage = ((deal?.pipeline_stages ?? {}) as { name?: string }).name ?? ''

    const lastActivity = [
      ...convs.map((v) => str(v.last_message_at)),
      ...cDeals.map((d) => str(d.updated_at)),
      str(c.created_at),
    ]
      .filter(Boolean)
      .sort()
      .pop() ?? ''
    const inactiveDays = lastActivity ? Math.floor((now - Date.parse(lastActivity)) / DAY_MS) : null

    const status = cDeals.some((d) => d.status === 'won')
      ? 'Ganado'
      : cDeals.some((d) => d.status === 'open')
        ? 'En negociación'
        : cDeals.some((d) => d.status === 'lost')
          ? 'Perdido'
          : cQuotes.length > 0
            ? 'Cotizado'
            : convs.length > 0
              ? 'Conversando'
              : 'Lead'

    const sellerId = str(deal?.assigned_to) || str(convs[0]?.assigned_agent_id)
    return [
      str(c.name),
      str(c.phone),
      str(convs[convs.length - 1]?.channel) || '',
      str(c.created_at),
      str(c.lead_temperature),
      convs.length,
      cQuotes.length,
      cQuotes.reduce((sum, q) => sum + num(q.total), 0),
      str(cQuotes[0]?.currency) || str(deal?.currency),
      str(deal?.title),
      stage,
      deal ? num(deal.value) : null,
      status,
      names.get(sellerId) ?? '',
      lastActivity,
      inactiveDays,
    ]
  })
  return pack(
    'Export Embudo',
    ['Cliente', 'Teléfono', 'Canal', 'Creado', 'Temperatura', '# Conversaciones', '# Cotizaciones', 'Monto cotizado', 'Moneda', 'Negociación actual', 'Etapa', 'Monto negociación', 'Estado', 'Vendedor', 'Última actividad', 'Días inactivo'],
    rows,
  )
}

async function exportProducts(db: SupabaseClient, accountId: string): Promise<ExportResult> {
  const products = (await readAll(db, accountId, 'products', 'id, name, description, price, installation_cost, is_active, created_at')).sort(
    (a, b) => str(a.name).localeCompare(str(b.name)),
  )
  const rows = products.map((p) => [
    str(p.name),
    str(p.description),
    num(p.price),
    num(p.installation_cost),
    p.is_active ? 'Sí' : 'No',
    str(p.created_at),
  ])
  return pack(
    'Export Productos',
    ['Nombre', 'Descripción', 'Precio', 'Costo instalación', 'Activo', 'Creado'],
    rows,
  )
}
