'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarRange, ClipboardList, MoonStar, Percent } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import {
  daysAgoStart,
  startOfLocalDay,
  granularityForRangeDays,
  formatDateRangeLabel,
} from '@/lib/dashboard/date-utils'
import { loadHotelMetrics, type HotelMetricsData } from '@/lib/hotel-metrics/queries'
import {
  computeHotelKpis,
  hotelDaySeries,
  hotelCategoryBreakdown,
  type DateWindow,
} from '@/lib/hotel-metrics/compute'
import { periodDelta } from '@/lib/kpis/compute'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { ChartSection } from '@/components/kpis/chart-section'
import { KpiLineChart } from '@/components/kpis/kpi-line-chart'
import { KpiDonutChart } from '@/components/kpis/kpi-donut-chart'
import { HotelCategoryTable, CATEGORY_COLORS } from '@/components/hotel-metrics/category-table'
import { cn } from '@/lib/utils'

type RangeDays = 7 | 30 | 90 | 365
const RANGES: RangeDays[] = [7, 30, 90, 365]

function nights(v: number | null): string {
  return v == null ? '—' : v.toFixed(1)
}

export function HotelKpis() {
  const t = useTranslations('Kpis.hotel')
  const { defaultCurrency, canEditSettings, profileLoading } = useAuth()

  const [range, setRange] = useState<RangeDays>(30)
  const [data, setData] = useState<HotelMetricsData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    // `loading` starts true and this runs once; the setState calls all
    // live in the async callbacks below (keeps react-hooks/set-state-in-effect happy).
    const db = createClient()
    const since = daysAgoStart(365 * 2).toISOString()
    loadHotelMetrics(db, since)
      .then(setData)
      .catch((err) => console.error('[hotel-kpis] load failed:', err))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const granularity = granularityForRangeDays(range)

  const view = useMemo(() => {
    if (!data) return null
    const window: DateWindow = { start: daysAgoStart(range - 1), end: startOfLocalDay() }
    const prevWindow: DateWindow = {
      start: daysAgoStart(range * 2 - 1),
      end: daysAgoStart(range),
    }
    const k = computeHotelKpis(data.reservations, data.roomCount, window)
    const prev = computeHotelKpis(data.reservations, data.roomCount, prevWindow)
    const series = hotelDaySeries(data.reservations, window)
    const breakdown = hotelCategoryBreakdown(data.reservations, window)
    return { k, prev, series, breakdown, window }
  }, [data, range])

  const donutData =
    view?.breakdown
      .filter((b) => b.requests > 0)
      .map((b) => ({
        name: t(`cat.${b.category}` as never),
        value: b.requests,
        color: CATEGORY_COLORS[b.category] ?? CATEGORY_COLORS.otros,
      })) ?? []

  if (profileLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }
  if (!canEditSettings) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center">
        <h1 className="text-lg font-semibold text-foreground">{t('adminOnlyTitle')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{t('adminOnlyHint')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
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
              {r === 365 ? t('rangeYear') : t('rangeDays', { count: r })}
            </button>
          ))}
        </div>
      </div>

      {view && (
        <p className="text-xs text-muted-foreground">
          {t('periodLabel', { range: formatDateRangeLabel(view.window.start, view.window.end) })}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading || !view ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('requests')}
              value={view.k.requests.toLocaleString()}
              icon={ClipboardList}
              delta={periodDelta(view.k.requests, view.prev.requests, t('vsPrev'))}
              subtitle={t('requestsSub')}
            />
            <MetricCard
              title={t('approvalRate')}
              value={
                view.k.approvalRate == null
                  ? '—'
                  : `${Math.round(view.k.approvalRate * 100)}%`
              }
              icon={Percent}
              subtitle={t('approvalSub', {
                approved: view.k.requestsApproved,
                denied: view.k.requestsDenied,
                pending: view.k.requestsPending,
              })}
            />
            <MetricCard
              title={t('avgStay')}
              value={nights(view.k.avgLengthOfStay)}
              icon={MoonStar}
              subtitle={t('avgStaySub')}
            />
            <MetricCard
              title={t('leadTime')}
              value={
                view.k.avgLeadTimeDays == null
                  ? '—'
                  : t('leadTimeValue', { days: Math.round(view.k.avgLeadTimeDays) })
              }
              icon={CalendarRange}
              subtitle={t('leadTimeSub')}
            />
          </>
        )}
      </div>

      {/* Every product category the hotel offers */}
      <ChartSection
        title={t('byCategory')}
        description={t('byCategoryDesc')}
        loading={loading}
        empty={!!view && view.breakdown.every((b) => b.requests === 0)}
        emptyHint={t('noRequestsYet')}
      >
        {view && <HotelCategoryTable rows={view.breakdown} currency={defaultCurrency} />}
      </ChartSection>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartSection
          title={t('requestsOverTime')}
          description={t('requestsOverTimeDesc')}
          loading={loading}
          empty={!!view && view.k.requests === 0}
          emptyHint={t('noRequestsYet')}
        >
          {view && (
            <KpiLineChart
              data={view.series.map((p) => ({ key: p.day, value: p.requests }))}
              granularity={granularity}
              color="blue"
            />
          )}
        </ChartSection>
        <ChartSection
          title={t('revenueOverTime')}
          description={t('revenueOverTimeDesc')}
          loading={loading}
          empty={!!view && view.k.revenue === 0}
          emptyHint={t('noReservationsYet')}
        >
          {view && (
            <KpiLineChart
              data={view.series.map((p) => ({ key: p.day, value: Math.round(p.revenue) }))}
              granularity={granularity}
              color="emerald"
              valueFormatter={(v) => formatCurrency(v, defaultCurrency)}
            />
          )}
        </ChartSection>
      </div>

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
              color="violet"
            />
          )}
        </ChartSection>
        <ChartSection
          title={t('statusMix')}
          description={t('statusMixDesc')}
          loading={loading}
          empty={!!view && view.k.requests === 0}
          emptyHint={t('noRequestsYet')}
          bodyClassName="p-5 pb-2"
        >
          {view && (
            <KpiDonutChart
              data={[
                { name: t('status.approved'), value: view.k.requestsApproved, color: '#10b981' },
                { name: t('status.pending'), value: view.k.requestsPending, color: '#f59e0b' },
                { name: t('status.denied'), value: view.k.requestsDenied, color: '#ef4444' },
              ].filter((s) => s.value > 0)}
              centerValue={view.k.requests}
              centerLabel={t('requests')}
            />
          )}
        </ChartSection>
      </div>

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
  )
}
