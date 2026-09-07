'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  BedDouble,
  CalendarCheck,
  CalendarClock,
  DollarSign,
  Percent,
  TrendingUp,
  Users,
} from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import {
  daysAgoStart,
  startOfLocalDay,
  granularityForRangeDays,
} from '@/lib/dashboard/date-utils'
import { loadHotelMetrics, type HotelMetricsData } from '@/lib/hotel-metrics/queries'
import {
  computeHotelKpis,
  hotelDaySeries,
  hotelCategoryMix,
  upcomingArrivalsDepartures,
  type DateWindow,
} from '@/lib/hotel-metrics/compute'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ChartSection } from '@/components/kpis/chart-section'
import { KpiLineChart } from '@/components/kpis/kpi-line-chart'
import { KpiDonutChart } from '@/components/kpis/kpi-donut-chart'
import { cn } from '@/lib/utils'

type RangeDays = 7 | 30 | 90
const RANGES: RangeDays[] = [7, 30, 90]

const CATEGORY_COLORS: Record<string, string> = {
  habitaciones: '#3b82f6',
  spa: '#a855f7',
  actividades: '#10b981',
  paquetes: '#f59e0b',
  eventos: '#ef4444',
  otros: '#6b7280',
}

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`
}

export function HotelDashboard() {
  const t = useTranslations('Dashboard.hotel')
  const { defaultCurrency } = useAuth()

  const [range, setRange] = useState<RangeDays>(30)
  const [data, setData] = useState<HotelMetricsData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    // `loading` starts true and this runs once; the setState calls all
    // live in the async callbacks below (keeps react-hooks/set-state-in-effect happy).
    const db = createClient()
    // Pull enough history for the widest range's comparison period too.
    const since = daysAgoStart(90 * 2).toISOString()
    loadHotelMetrics(db, since)
      .then(setData)
      .catch((err) => console.error('[hotel-dashboard] load failed:', err))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const window: DateWindow = useMemo(
    () => ({ start: daysAgoStart(range - 1), end: startOfLocalDay() }),
    [range],
  )

  const view = useMemo(() => {
    if (!data) return null
    const k = computeHotelKpis(data.reservations, data.roomCount, window)
    const series = hotelDaySeries(data.reservations, window)
    const mix = hotelCategoryMix(data.reservations, window)
    const next7 = upcomingArrivalsDepartures(data.reservations, new Date())
    return { k, series, mix, next7 }
  }, [data, window])

  const granularity = granularityForRangeDays(range)

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                range === r
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('rangeDays', { count: r })}
            </button>
          ))}
        </div>
      </div>

      {/* Revenue-management cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading || !view ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('occupancy')}
              value={pct(view.k.occupancy)}
              icon={Percent}
              subtitle={
                view.k.availableRoomNights == null
                  ? t('occupancyNoRooms')
                  : t('occupancySub', {
                      sold: view.k.roomNights,
                      available: view.k.availableRoomNights,
                    })
              }
            />
            <MetricCard
              title={t('revenue')}
              value={formatCurrency(view.k.revenue, defaultCurrency)}
              icon={DollarSign}
              subtitle={t('revenueSub')}
            />
            <MetricCard
              title={t('adr')}
              value={view.k.adr == null ? '—' : formatCurrency(view.k.adr, defaultCurrency)}
              icon={BedDouble}
              subtitle={t('adrSub')}
            />
            <MetricCard
              title={t('revpar')}
              value={
                view.k.revpar == null ? '—' : formatCurrency(view.k.revpar, defaultCurrency)
              }
              icon={TrendingUp}
              subtitle={t('revparSub')}
            />
          </>
        )}
      </div>

      {/* Next 7 days */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {loading || !view ? (
          Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('arrivals')}
              value={view.next7.arrivals.toLocaleString()}
              icon={CalendarCheck}
              subtitle={t('arrivalsSub', { guests: view.next7.arrivalGuests })}
            />
            <MetricCard
              title={t('departures')}
              value={view.next7.departures.toLocaleString()}
              icon={CalendarClock}
              subtitle={t('departuresSub')}
            />
            <MetricCard
              title={t('expectedGuests')}
              value={view.k.guests.toLocaleString()}
              icon={Users}
              subtitle={t('expectedGuestsSub')}
            />
          </>
        )}
      </div>

      <QuickActions />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartSection
          title={t('occByDay')}
          description={t('occByDayDesc')}
          loading={loading}
          empty={!!view && view.series.every((p) => p.roomNights === 0)}
          emptyHint={t('noReservationsYet')}
        >
          {view && (
            <KpiLineChart
              data={view.series.map((p) => ({ key: p.day, value: p.roomNights }))}
              granularity={granularity}
              color="blue"
            />
          )}
        </ChartSection>
        <ChartSection
          title={t('categoryMix')}
          description={t('categoryMixDesc')}
          loading={loading}
          empty={!!view && view.mix.length === 0}
          emptyHint={t('noRequestsYet')}
          bodyClassName="p-5 pb-2"
        >
          {view && (
            <KpiDonutChart
              data={view.mix.map((m) => ({
                name: t(`cat.${m.category}` as never),
                value: m.requests,
                color: CATEGORY_COLORS[m.category] ?? CATEGORY_COLORS.otros,
              }))}
              centerValue={view.mix.reduce((s, m) => s + m.requests, 0)}
              centerLabel={t('requests')}
            />
          )}
        </ChartSection>
      </div>
    </section>
  )
}
