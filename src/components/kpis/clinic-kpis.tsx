'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { IconTrendingUp } from '@tabler/icons-react'
import { useAuth } from '@/hooks/use-auth'
import { readResponseJson } from '@/lib/http/response-json'
import { formatCurrency } from '@/lib/currency'
import {
  DASHBOARD_PERIODS,
  dashboardPeriodBounds,
  type DashboardPeriod,
} from '@/lib/clinic/time-range'
import type { ClinicDashboardStats } from '@/lib/clinic-metrics/types'

function pct(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(1)}%`
}

export function ClinicKpis() {
  const t = useTranslations('Clinic.kpis')
  const { account } = useAuth()
  const currency = account?.default_currency || 'GTQ'
  const tz = account?.timezone || 'UTC'

  const [period, setPeriod] = useState<DashboardPeriod>('month')
  const [stats, setStats] = useState<ClinicDashboardStats | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { from, to } = dashboardPeriodBounds(period, tz)
      const res = await fetch(`/api/clinic-dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      const body = await readResponseJson<ClinicDashboardStats>(res)
      setStats(res.ok ? body : null)
    } catch {
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [period, tz])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <IconTrendingUp className="text-primary h-5 w-5" />
          <h1 className="text-foreground text-lg font-semibold">{t('title')}</h1>
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as DashboardPeriod)}
          className="border-border bg-background h-8 rounded-md border px-2 text-sm"
        >
          {DASHBOARD_PERIODS.map((p) => (
            <option key={p} value={p}>
              {t(`period_${p}`)}
            </option>
          ))}
        </select>
      </div>

      {loading || !stats ? (
        <div className="bg-muted/40 h-80 animate-pulse rounded-lg" />
      ) : (
        <>
          {/* Conversion funnel (spec §17) */}
          <div className="border-border bg-card rounded-lg border p-4">
            <h2 className="text-foreground mb-3 text-sm font-semibold">{t('funnelTitle')}</h2>
            <div className="space-y-2">
              <FunnelBar label={t('fConversations')} value={stats.conversions.conversations} max={stats.conversions.conversations} />
              <FunnelBar label={t('fBooked')} value={stats.conversions.bookedAppointments} max={stats.conversions.conversations} />
              <FunnelBar label={t('fConfirmed')} value={stats.appointments.confirmed} max={stats.conversions.conversations} />
              <FunnelBar label={t('fCompleted')} value={stats.conversions.completedVisits} max={stats.conversions.conversations} />
            </div>
            <div className="text-muted-foreground mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <span>{t('convToAppt', { v: pct(stats.conversions.bookingConversionRate) })}</span>
              <span>{t('convToVisit', { v: pct(stats.conversions.completedConversionRate) })}</span>
            </div>
          </div>

          {/* Revenue by patient segment */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card label={t('revTotal')} value={formatCurrency(stats.revenue.total, currency)} />
            <Card
              label={t('revNew')}
              value={formatCurrency(stats.newPatients.revenue, currency)}
              sub={t('nPatients', { n: stats.newPatients.count })}
            />
            <Card
              label={t('revReturning')}
              value={formatCurrency(stats.returningPatients.revenue, currency)}
              sub={t('nPatients', { n: stats.returningPatients.count })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card label={t('confirmationRate')} value={pct(stats.appointments.confirmationRate)} />
            <Card label={t('noShows')} value={String(stats.appointments.noShows)} sub={pct(stats.appointments.noShowRate)} />
            <Card
              label={t('humanResponse')}
              value={
                stats.humanResponse.averageSeconds == null
                  ? '—'
                  : `${Math.floor(stats.humanResponse.averageSeconds / 60)}m ${Math.round(stats.humanResponse.averageSeconds % 60)}s`
              }
            />
            <Card label={t('appointments')} value={String(stats.appointments.total)} />
          </div>
        </>
      )}
    </div>
  )
}

function FunnelBar({ label, value, max }: { label: string; value: number; max: number }) {
  const w = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 4
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground tabular-nums font-medium">{value}</span>
      </div>
      <div className="bg-muted mt-1 h-2 overflow-hidden rounded">
        <div className="bg-primary h-full rounded" style={{ width: `${w}%` }} />
      </div>
    </div>
  )
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-border bg-card rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {sub ? <p className="text-muted-foreground mt-0.5 text-xs">{sub}</p> : null}
    </div>
  )
}
