'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  BedDouble,
  CalendarCheck,
  CalendarClock,
  DollarSign,
  Percent,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import {
  daysAgoStart,
  startOfNextLocalDay,
  granularityForRangeDays,
} from '@/lib/dashboard/date-utils'
import { loadHotelMetrics, type HotelMetricsData } from '@/lib/hotel-metrics/queries'
import {
  computeHotelKpis,
  hotelDaySeries,
  hotelCategoryBreakdown,
  upcomingArrivalsDepartures,
  type DateWindow,
} from '@/lib/hotel-metrics/compute'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ChartSection } from '@/components/kpis/chart-section'
import { KpiLineChart } from '@/components/kpis/kpi-line-chart'
import { KpiDonutChart } from '@/components/kpis/kpi-donut-chart'
import { HotelCategoryTable, CATEGORY_COLORS } from '@/components/hotel-metrics/category-table'
import { cn } from '@/lib/utils'

type RangeDays = 7 | 30 | 90
const RANGES: RangeDays[] = [7, 30, 90]

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`
}

export function HotelDashboard() {
  const t = useTranslations('Dashboard.hotel')
  const errors = useTranslations('HotelMetricsError')
  const { defaultCurrency } = useAuth()

  const [range, setRange] = useState<RangeDays>(30)
  const [data, setData] = useState<HotelMetricsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    // `loading` starts true and this runs once; the setState calls all
    // live in the async callbacks below (keeps react-hooks/set-state-in-effect happy).
    const db = createClient()
    // Pull enough history for the widest range's comparison period too.
    const since = daysAgoStart(90 * 2).toISOString()
    loadHotelMetrics(db, since)
      .then((result) => { setData(result); setFailed(false) })
      .catch((err) => { console.error('[hotel-dashboard] load failed:', err); setFailed(true) })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const window: DateWindow = useMemo(
    // `end` is exclusive in hotel-metrics — use start-of-tomorrow so
    // everything that happened today is inside the window.
    () => ({ start: daysAgoStart(range - 1), end: startOfNextLocalDay() }),
    [range],
  )

  const view = useMemo(() => {
    if (!data) return null
    const k = computeHotelKpis(data.reservations, data.roomCount, window)
    const series = hotelDaySeries(data.reservations, window)
    const breakdown = hotelCategoryBreakdown(data.reservations, window)
    const next7 = upcomingArrivalsDepartures(data.reservations, new Date())
    return { k, series, breakdown, next7 }
  }, [data, window])

  const granularity = granularityForRangeDays(range)
  const donutData =
    view?.breakdown
      .filter((b) => b.requests > 0)
      .map((b) => ({
        name: t(`cat.${b.category}` as never),
        value: b.requests,
        color: CATEGORY_COLORS[b.category] ?? CATEGORY_COLORS.otros,
      })) ?? []

  if (failed) return <div role="alert" className="space-y-3 p-4">
    <p>{errors('message')}</p>
    <button onClick={load} className="underline">{errors('retry')}</button>
  </div>

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

      {/* Room revenue-management cards (category "Habitaciones") */}
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading || !view ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
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
              title={t('upcomingServices')}
              value={view.next7.services.toLocaleString()}
              icon={Sparkles}
              subtitle={t('upcomingServicesSub')}
            />
            <MetricCard
              title={t('expectedGuests')}
              value={(view.next7.arrivalGuests + view.next7.serviceGuests).toLocaleString()}
              icon={Users}
              subtitle={t('expectedGuestsSub')}
            />
          </>
        )}
      </div>

      <QuickActions />

      {/* Every category the hotel offers, at a glance */}
      <ChartSection
        title={t('byCategory')}
        description={t('byCategoryDesc')}
        loading={loading}
        empty={!!view && view.breakdown.every((b) => b.requests === 0)}
        emptyHint={t('noRequestsYet')}
      >
        {view && (
          <HotelCategoryTable rows={view.breakdown} currency={defaultCurrency} compact />
        )}
      </ChartSection>

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
          empty={!!view && donutData.length === 0}
          emptyHint={t('noRequestsYet')}
          bodyClassName="p-5 pb-2"
        >
          {view && (
            <KpiDonutChart
              data={donutData}
              centerValue={donutData.reduce((s, d) => s + d.value, 0)}
              centerLabel={t('requests')}
            />
          )}
        </ChartSection>
      </div>
    </section>
  )
}
