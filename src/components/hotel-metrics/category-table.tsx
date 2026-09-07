'use client'

import { useTranslations } from 'next-intl'

import { formatCurrency } from '@/lib/currency'
import type { CategoryStat } from '@/lib/hotel-metrics/compute'

/** One palette for every hotel category, shared by the donuts and this
 *  table so a category keeps the same colour across the page. */
export const CATEGORY_COLORS: Record<string, string> = {
  habitaciones: '#3b82f6',
  spa: '#a855f7',
  actividades: '#10b981',
  paquetes: '#f59e0b',
  eventos: '#ef4444',
  otros: '#6b7280',
}

function rate(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`
}

/**
 * Per-category demand breakdown — every product category the hotel
 * offers gets a row (even at zero requests), so the Panel / KPIs never
 * hide a category. `compact` drops the guests column for the narrower
 * Panel placement.
 */
export function HotelCategoryTable({
  rows,
  currency,
  compact = false,
}: {
  rows: CategoryStat[]
  currency: string
  compact?: boolean
}) {
  const t = useTranslations('HotelMetrics')

  const totals = rows.reduce(
    (a, r) => ({
      requests: a.requests + r.requests,
      approved: a.approved + r.approved,
      estRevenue: a.estRevenue + r.estRevenue,
      guests: a.guests + r.guests,
    }),
    { requests: 0, approved: 0, estRevenue: 0, guests: 0 },
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
            <th className="py-2 pr-3 font-medium">{t('col.category')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('col.requests')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('col.approved')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('col.approvalRate')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('col.revenue')}</th>
            {!compact && (
              <th className="py-2 pl-3 text-right font-medium">{t('col.guests')}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.category} className="border-b border-border/60 last:border-0">
              <td className="py-2 pr-3">
                <span className="flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: CATEGORY_COLORS[r.category] ?? CATEGORY_COLORS.otros }}
                  />
                  <span className="text-foreground">{t(`cat.${r.category}` as never)}</span>
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-foreground">
                {r.requests.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {r.approved.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {rate(r.approvalRate)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {r.estRevenue > 0 ? formatCurrency(r.estRevenue, currency) : '—'}
              </td>
              {!compact && (
                <td className="py-2 pl-3 text-right tabular-nums text-muted-foreground">
                  {r.guests.toLocaleString()}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="text-xs font-medium text-foreground">
            <td className="py-2 pr-3">{t('col.total')}</td>
            <td className="px-3 py-2 text-right tabular-nums">
              {totals.requests.toLocaleString()}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">
              {totals.approved.toLocaleString()}
            </td>
            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">—</td>
            <td className="px-3 py-2 text-right tabular-nums">
              {totals.estRevenue > 0 ? formatCurrency(totals.estRevenue, currency) : '—'}
            </td>
            {!compact && (
              <td className="py-2 pl-3 text-right tabular-nums">
                {totals.guests.toLocaleString()}
              </td>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
