'use client'

// Self-contained Spanish strings, like settings/csat-config.tsx.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatMinutesLabel } from '@/lib/dashboard/date-utils'
import { formatCurrency } from '@/lib/currency'
import { loadTeamReport, type TeamReport } from '@/lib/kpis/team'
import type { DateWindow } from '@/lib/kpis/types'
import { ChartSection } from '@/components/kpis/chart-section'

/** Pipeline stage funnel + per-agent leaderboard for `window`. */
export function TeamPerformance({ window, currency }: { window: DateWindow; currency: string }) {
  const [report, setReport] = useState<TeamReport | null>(null)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const key = `${window.start.toISOString()}|${window.end.toISOString()}`

  useEffect(() => {
    let cancelled = false
    loadTeamReport(createClient(), window)
      .then((r) => !cancelled && setReport(r))
      .catch((err) => console.error('[kpis] team report failed:', err))
      .finally(() => !cancelled && setLoadedFor(key))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the window
  }, [key])

  const loading = loadedFor !== key

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ChartSection
        title="Embudo del pipeline"
        description="Negocios creados en el periodo y hasta qué etapa llegó cada uno."
        loading={loading}
        empty={!report || report.funnels.length === 0}
        emptyHint="No se crearon negocios en este periodo."
      >
        <div className="space-y-5">
          {report?.funnels.map((f) => (
            <div key={f.pipelineId} className="space-y-2">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-foreground font-medium">{f.name}</span>
                <span className="text-muted-foreground text-xs">
                  {f.total} negocios · {f.won} ganados · {f.lost} perdidos
                </span>
              </div>
              {f.stages.map((s) => {
                const pct = f.total ? Math.round((s.reached / f.total) * 100) : 0
                return (
                  <div key={s.id} className="flex items-center gap-3 text-xs">
                    <span className="text-muted-foreground w-28 shrink-0 truncate" title={s.name}>
                      {s.name}
                    </span>
                    <div className="bg-muted h-5 flex-1 overflow-hidden rounded">
                      <div
                        className="bg-primary h-full rounded"
                        style={{ width: `${pct}%`, backgroundColor: s.color ?? undefined }}
                      />
                    </div>
                    <span className="text-foreground w-16 shrink-0 text-right tabular-nums">
                      {s.reached} · {pct}%
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </ChartSection>

      <ChartSection
        title="Ranking del equipo"
        description="Por asesor: chats abiertos ahora, cerrados, respuestas desde la bandeja, tiempo de respuesta y ventas."
        loading={loading}
        empty={!report || report.agents.length === 0}
        bodyClassName="overflow-x-auto"
      >
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="py-1 pr-2 font-medium">Asesor</th>
              <th className="px-2 py-1 text-right font-medium">Abiertos</th>
              <th className="px-2 py-1 text-right font-medium">Cerrados</th>
              <th className="px-2 py-1 text-right font-medium">Respuestas</th>
              <th className="px-2 py-1 text-right font-medium">T. resp.</th>
              <th className="py-1 pl-2 text-right font-medium">Ventas</th>
            </tr>
          </thead>
          <tbody>
            {report?.agents.map((a) => (
              <tr key={a.userId} className="border-border border-t">
                <td className="text-foreground max-w-40 truncate py-2 pr-2" title={a.name}>
                  {a.name}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{a.openAssigned}</td>
                <td className="px-2 py-2 text-right tabular-nums">{a.closed}</td>
                <td className="px-2 py-2 text-right tabular-nums">{a.replies}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatMinutesLabel(a.medianResponseMin)}</td>
                <td className="py-2 pl-2 text-right tabular-nums">
                  {a.wonDeals}
                  {a.wonDeals > 0 && <span className="text-muted-foreground"> · {formatCurrency(a.wonValue, currency)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-muted-foreground mt-3 text-[11px]">
          Respuestas y tiempo de respuesta cuentan desde el 1 de noviembre de 2026, cuando empezamos a registrar quién envía
          cada mensaje.
        </p>
      </ChartSection>
    </div>
  )
}
