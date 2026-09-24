'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarClock, Check, Loader2, X } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { useCan } from '@/hooks/use-can'
import { readResponseJson } from '@/lib/http/response-json'
import { formatCurrency } from '@/lib/currency'
import { Button } from '@/components/ui/button'

type ReservationCategory = 'habitaciones' | 'spa' | 'actividades' | 'paquetes' | 'eventos'

interface ReservationRow {
  id: string
  category: ReservationCategory
  service_name: string | null
  guests: number | null
  rooms?: number | null
  check_in: string | null
  check_out: string | null
  use_date: string | null
  hall: string | null
  estimated_price: number | null
}

/**
 * Pending hotel reservation/service requests for THIS conversation, with
 * Aprobar/Rechazar buttons (spec: Angel, 2026-09-17 — "el botón de
 * rechazar reservas para cada conversación"). `hotel` vertical only.
 *
 * Approving/denying goes through `PATCH /api/reservations/[id]`, which
 * already re-fires `reservation.updated` — the Google Sheets row for
 * this request is rewritten with the matching "Aprobación" cell in the
 * same call, no extra plumbing needed here.
 */
export function InboxReservationsCard({ conversationId }: { conversationId: string | null }) {
  const t = useTranslations('HotelReservations')
  const tCat = useTranslations('HotelMetrics.cat')
  const { account, defaultCurrency } = useAuth()
  const canAct = useCan('manage-products')
  const isHotel = (account?.industry_vertical ?? 'generic') === 'hotel'

  const [rows, setRows] = useState<ReservationRow[]>([])
  const [checked, setChecked] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (cid: string, alive: () => boolean) => {
    setChecked(false)
    try {
      const res = await fetch(
        `/api/reservations?conversation_id=${encodeURIComponent(cid)}&status=pending`,
      )
      const body = await readResponseJson<{ reservations: ReservationRow[] }>(res)
      if (alive()) setRows(body?.reservations ?? [])
    } catch {
      if (alive()) setRows([])
    } finally {
      if (alive()) setChecked(true)
    }
  }, [])

  useEffect(() => {
    if (!isHotel || !conversationId) {
      setRows([])
      setChecked(true)
      return
    }
    let on = true
    void load(conversationId, () => on)
    return () => {
      on = false
    }
  }, [isHotel, conversationId, load])

  async function decide(id: string, status: 'approved' | 'denied') {
    setBusyId(id)
    try {
      const res = await fetch(`/api/reservations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const body = await readResponseJson(res).catch(() => ({}))
        console.error('[reservations] status update failed:', body)
        return
      }
      setRows((prev) => prev.filter((r) => r.id !== id))
    } finally {
      setBusyId(null)
    }
  }

  if (!isHotel || !checked || rows.length === 0) return null

  const categoryLabel = (c: ReservationCategory) => tCat(c)

  return (
    <div className="border-border bg-muted/40 mt-3 space-y-2 rounded-lg border p-3 text-left text-xs">
      <div className="text-foreground flex items-center gap-1.5 font-medium">
        <CalendarClock className="size-3.5" />
        {t('title')}
      </div>
      {rows.map((r) => {
        const dateText =
          r.check_in && r.check_out ? `${r.check_in} → ${r.check_out}` : (r.use_date ?? null)
        const busy = busyId === r.id
        return (
          <div key={r.id} className="bg-card border-border space-y-1 rounded-md border px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground font-medium">
                {r.service_name || categoryLabel(r.category)}
              </span>
              <span className="text-muted-foreground shrink-0 text-[10px] uppercase">
                {categoryLabel(r.category)}
              </span>
            </div>
            <div className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5">
              {dateText && <span>{dateText}</span>}
              {r.rooms != null && r.rooms > 1 && <span>{t('rooms', { count: r.rooms })}</span>}
              {r.guests != null && <span>{t('guests', { count: r.guests })}</span>}
              {r.hall && <span>{r.hall}</span>}
              {r.estimated_price != null && (
                <span>{formatCurrency(r.estimated_price, defaultCurrency)}</span>
              )}
            </div>
            <div className="flex gap-1.5 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="h-6 flex-1 border-emerald-700/50 bg-emerald-950/20 text-[11px] text-emerald-300 hover:bg-emerald-950/40"
                disabled={!canAct || busy}
                onClick={() => decide(r.id, 'approved')}
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                {t('approve')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 flex-1 border-red-800/50 bg-red-950/20 text-[11px] text-red-300 hover:bg-red-950/40"
                disabled={!canAct || busy}
                onClick={() => decide(r.id, 'denied')}
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                {t('deny')}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
