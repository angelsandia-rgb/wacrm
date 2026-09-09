'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  IconStethoscope,
  IconAlertTriangle,
  IconTrendingUp,
  IconTrendingDown,
} from '@tabler/icons-react'
import { useAuth } from '@/hooks/use-auth'
import { readResponseJson } from '@/lib/http/response-json'
import { formatCurrency } from '@/lib/currency'
import { cn } from '@/lib/utils'
import {
  DASHBOARD_PERIODS,
  dashboardPeriodBounds,
  type DashboardPeriod,
} from '@/lib/clinic/time-range'
import type { ClinicDashboardStats } from '@/lib/clinic-metrics/types'

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m} min ${s} s` : `${s} s`
}
function pct(v: number | null): string {
  return v == null ? '—' : `${v >= 0 ? '' : ''}${v.toFixed(1)}%`
}

export function ClinicDashboard() {
  const t = useTranslations('Clinic.dash')
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

  const dtFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('es-GT', {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: tz,
      }),
    [tz],
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <IconStethoscope className="text-primary h-5 w-5" />
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
        <div className="bg-muted/40 h-96 animate-pulse rounded-lg" />
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              label={t('kpiRevenue')}
              value={formatCurrency(stats.revenue.total, currency)}
              sub={
                stats.revenue.percentageChange == null ? (
                  t('vsPrevNA')
                ) : (
                  <span
                    className={cn(
                      'inline-flex items-center gap-0.5',
                      stats.revenue.percentageChange >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
                    )}
                  >
                    {stats.revenue.percentageChange >= 0 ? (
                      <IconTrendingUp className="size-3" />
                    ) : (
                      <IconTrendingDown className="size-3" />
                    )}
                    {pct(stats.revenue.percentageChange)} {t('vsPrev')}
                  </span>
                )
              }
            />
            <Kpi
              label={t('kpiNewPatients')}
              value={String(stats.newPatients.count)}
              sub={t('generated', { amount: formatCurrency(stats.newPatients.revenue, currency) })}
            />
            <Kpi
              label={t('kpiReturningPatients')}
              value={String(stats.returningPatients.count)}
              sub={t('generated', { amount: formatCurrency(stats.returningPatients.revenue, currency) })}
            />
            <Kpi label={t('kpiAppointments')} value={String(stats.appointments.total)} sub={t('inPeriod')} />
            <Kpi
              label={t('kpiConfirmation')}
              value={pct(stats.appointments.confirmationRate)}
              sub={t('confirmedOf', { n: stats.appointments.confirmed })}
            />
            <Kpi
              label={t('kpiNoShows')}
              value={String(stats.appointments.noShows)}
              sub={stats.appointments.noShowRate == null ? '' : pct(stats.appointments.noShowRate)}
            />
            <Kpi
              label={t('kpiHumanResponse')}
              value={fmtDuration(stats.humanResponse.averageSeconds)}
              sub={t('samples', { n: stats.humanResponse.sampleSize })}
            />
            <Kpi
              label={t('kpiConversion')}
              value={pct(stats.conversions.completedConversionRate)}
              sub={t('convFunnel', {
                c: stats.conversions.conversations,
                a: stats.conversions.bookedAppointments,
                v: stats.conversions.completedVisits,
              })}
            />
          </div>

          {/* Attention required */}
          <div className="border-border bg-card rounded-lg border p-4">
            <h2 className="text-foreground mb-3 flex items-center gap-2 text-sm font-semibold">
              <IconAlertTriangle className="size-4 text-amber-500" />
              {t('attentionTitle')}
            </h2>
            <ul className="space-y-1.5 text-sm">
              <AttnRow
                count={stats.attentionRequired.unconfirmedAppointments}
                href="/appointments?status=SCHEDULED"
                label={t('attnUnconfirmed')}
              />
              <AttnRow
                count={stats.attentionRequired.noShows}
                href="/appointments?status=NO_SHOW"
                label={t('attnNoShows')}
              />
              <AttnRow
                count={stats.attentionRequired.followUps}
                href="/patients?filter=follow_up_due"
                label={t('attnFollowUps')}
              />
              <AttnRow
                count={stats.attentionRequired.conversationsWaiting}
                href="/inbox"
                label={t('attnConversations')}
              />
            </ul>
          </div>

          {/* Upcoming + chart */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="border-border bg-card rounded-lg border p-4">
              <h2 className="text-foreground mb-3 text-sm font-semibold">{t('upcomingTitle')}</h2>
              {stats.upcoming.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('noUpcoming')}</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {stats.upcoming.map((u) => (
                    <li key={u.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="text-foreground min-w-0 truncate">
                        <span className="tabular-nums">{dtFmt.format(new Date(u.scheduled_at))}</span>
                        {' · '}
                        {u.patient_name || '—'}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {u.doctor_name || ''} {u.confirmation_status === 'confirmed' ? '✅' : '⚠️'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="border-border bg-card rounded-lg border p-4">
              <h2 className="text-foreground mb-3 text-sm font-semibold">{t('byDayTitle')}</h2>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.byDay} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="scheduled" name={t('legScheduled')} fill="#94a3b8" />
                    <Bar dataKey="confirmed" name={t('legConfirmed')} fill="#3b82f6" />
                    <Bar dataKey="completed" name={t('legCompleted')} fill="#22c55e" />
                    <Bar dataKey="noShows" name={t('legNoShows')} fill="#ef4444" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="border-border bg-card rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub ? <p className="text-muted-foreground mt-0.5 text-xs">{sub}</p> : null}
    </div>
  )
}

function AttnRow({ count, href, label }: { count: number; href: string; label: string }) {
  const muted = count === 0
  return (
    <li>
      <Link
        href={href}
        className={cn(
          'flex items-center gap-2 rounded px-1 py-0.5',
          muted ? 'text-muted-foreground' : 'text-foreground hover:bg-muted',
        )}
      >
        <span className={cn('tabular-nums font-semibold', !muted && 'text-amber-600 dark:text-amber-400')}>
          {muted ? '✓' : `⚠️ ${count}`}
        </span>
        <span>{label}</span>
      </Link>
    </li>
  )
}
