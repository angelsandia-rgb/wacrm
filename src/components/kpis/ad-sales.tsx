'use client'

// Self-contained Spanish strings, like team-performance.tsx.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency } from '@/lib/currency'
import { loadAdSales, type AdSalesRow } from '@/lib/kpis/ad-sales'
import type { DateWindow } from '@/lib/kpis/types'
import { ChartSection } from '@/components/kpis/chart-section'

/** Leads, sales and revenue per Meta ad (click-to-WhatsApp / IG / FB) for `window`. */
export function AdSales({ window, currency }: { window: DateWindow; currency: string }) {
  const [rows, setRows] = useState<AdSalesRow[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const key = `${window.start.toISOString()}|${window.end.toISOString()}`

  useEffect(() => {
    let cancelled = false
    loadAdSales(createClient(), window)
      .then((r) => !cancelled && setRows(r))
      .catch((err) => console.error('[kpis] ad sales failed:', err))
      .finally(() => !cancelled && setLoadedFor(key))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the window
  }, [key])

  return (
    <ChartSection
      title="Ventas por anuncio"
      description="Clientes que llegaron desde un anuncio de Meta en el periodo, y cuántos compraron."
      loading={loadedFor !== key}
      empty={rows.length === 0}
      emptyHint="Todavía no hay clientes que hayan llegado desde un anuncio."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="py-1 pr-2 font-medium">Anuncio</th>
              <th className="px-2 py-1 text-right font-medium">Leads</th>
              <th className="px-2 py-1 text-right font-medium">Ventas</th>
              <th className="px-2 py-1 text-right font-medium">Conversión</th>
              <th className="py-1 pl-2 text-right font-medium">Monto</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-border border-t">
                <td className="max-w-56 py-2 pr-2">
                  <div className="text-foreground truncate" title={r.ad}>{r.ad}</div>
                  {r.campaign && <div className="text-muted-foreground truncate" title={r.campaign}>{r.campaign}</div>}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{r.leads}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.sales}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.leads ? `${Math.round((r.sales / r.leads) * 100)}%` : '—'}</td>
                <td className="py-2 pl-2 text-right tabular-nums">{formatCurrency(r.revenue, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartSection>
  )
}
